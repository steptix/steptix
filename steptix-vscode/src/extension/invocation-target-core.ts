/**
 * Where a `[skill: ...]` / `[tool: ...]` name POINTS — the file-resolution half
 * of Go-to-Definition and completion, extracted from the providers so it is
 * vscode-free and testable under `node --test`.
 *
 * Everything here mirrors a rule that already exists server-side:
 *
 *  - `toolFileFor`       mirrors `parseToolRef`   (src/tools/registry.ts)
 *  - `canonicalSkillName` mirrors `parseSkillCall` (src/skills/skill-call-parser.ts)
 *  - `collectSkillNames`  mirrors `loadSkill`'s `<skillsDir>/<name>.md` layout,
 *                         with `listToolFiles`' walk rules (registry.ts)
 *  - `parseInvocationLine` mirrors `parseInvocation`'s token finder
 *                         (src/parser/invocation-parser.ts)
 *  - `openSkillArgsContext` mirrors that parser's argument scanner
 *  - `skillIoFor`        reads `## Parameters` via runner-core's
 *                         `parseParameters` and `## Outputs` mirroring
 *                         `extractOutputs` (src/parser/markdown.ts)
 *
 * A mirror that drifts is worse than no mirror: F12 would open a different file
 * from the one the runner loads, and completion would offer names the parser
 * rejects. `tests/invocation-target-core.test.js` pins the parity rows against
 * the canonical implementations' own test tables.
 *
 * The one place the editor is deliberately MORE lenient than the parser is a
 * half-typed TOOL reference: an author mid-keystroke on `[tool: auth/login/]`
 * has not made an error yet, so navigation still resolves the file they are
 * heading for. Skill names get no such leniency — `canonicalSkillName` refuses
 * a trailing slash like every other empty segment. Genuine malformations
 * return `null` and the caller warns — the editor must never bless a name the
 * runner will reject.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
// A bare package import stays loadable under `node --test`'s direct-.ts
// loading (env-data-completion-core.ts set the precedent) — it resolves
// through node_modules to runner-core's built JS either way.
import { parseParameters, parseUseAiStep, parseUseStep, USE_SURFACES } from 'steptix-runner-core';

/**
 * Extensions a tool file may carry, in the order the registry probes them.
 * Mirrors `TOOL_FILE_EXTS` in src/tools/registry.ts.
 */
export const TOOL_FILE_EXTS = ['.ts', '.mts', '.js', '.mjs'] as const;

/** A path segment the invocation grammar can actually lex: `[\w-]+`, matching
 *  `readIdentifier`'s class in src/parser/invocation-parser.ts. */
const SEGMENT_RE = /^[\w-]+$/;

/**
 * Hard ceiling on directories visited per walk. The realpath `visited` set
 * already defeats symlink loops; this bounds the other pathology — a single
 * junction into some huge foreign tree (`skills/lib -> C:\big-repo`), which is
 * loop-free and would otherwise be walked in full, synchronously, on every
 * completion keystroke. Two thousand real directories of skills is far beyond
 * any plausible project; past it the walk stops quietly with what it has.
 */
const MAX_SKILL_DIRS = 2000;

/**
 * The file portion of a tool reference, relative to `toolsDir` and without an
 * extension — or `null` if the reference is malformed.
 *
 * Mirrors `parseToolRef` (src/tools/registry.ts): the **last** `/`-separated
 * segment is the tool name, everything before it is the file; a lone segment is
 * sugar for "the tool named after the file".
 *
 *   check_health      → check_health
 *   auth/login        → auth
 *   auth/login/login  → auth/login
 *
 * One deliberate leniency, because this is navigation rather than execution:
 * a TRAILING `/` means the author is still typing, so only that empty segment
 * is dropped and the remaining segments are the file — `auth/login/` →
 * `auth/login`, the file they are heading into. The last-segment-is-the-tool
 * rule is deliberately NOT applied to a still-typing ref, which is what makes
 * this land one directory deeper than a naive "drop all empty segments"
 * filter would.
 *
 * Every other empty segment — leading `/` included — is a malformation
 * `parseToolRef` throws on, so it returns `null` and the caller warns. (The
 * skill side legitimately strips a leading slash, because `[skill: /a/b]` IS
 * legal at runtime; `[tool: /a/b]` is not, and navigating on it would bless a
 * ref the runner rejects.)
 */
export function toolFileFor(ref: string): string | null {
  const stillTyping = ref.endsWith('/');
  const segments = ref.split('/');
  if (stillTyping) segments.pop(); // only the trailing empty segment
  if (segments.some((s) => s.length === 0)) return null;
  if (stillTyping) return segments.join('/');
  if (segments.length === 1) return segments[0]!;
  return segments.slice(0, -1).join('/');
}

/**
 * The canonical form of a skill name — no leading slash — or `null` when the
 * name has an empty path segment.
 *
 * Mirrors `parseSkillCall` (src/skills/skill-call-parser.ts) exactly, including
 * the rejection: `path.join` would silently collapse `auth//login` into a real
 * file, so navigating on it would bless a name the runner throws
 * `SkillCallSyntaxError` on. `null` keeps the editor and the runtime agreeing.
 */
export function canonicalSkillName(name: string): string | null {
  const stripped = name.startsWith('/') ? name.slice(1) : name;
  // `''.split('/')` is `['']`, so this also catches an empty name.
  if (stripped.split('/').some((s) => s.length === 0)) return null;
  return stripped;
}

/**
 * The heading text to look for inside a skill file: the name's last path
 * segment.
 *
 * A skill's H1 is *conventionally* its unqualified name, but nothing enforces
 * it — `skill.name` comes from the H1 and is independent of the filename. So
 * this is a best-effort landing spot; callers fall back to line 0 when no
 * matching heading is found.
 */
export function skillHeading(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/**
 * Every skill under `skillsDir`, named the way a step must reference it:
 * relative to the skills root, no `.md`, **forward slashes on every platform** —
 * a skill at `skills/auth/login.md` completes as `[skill: auth/login]`, which is
 * exactly what `parseSkillCall` canonicalises to. Sorted.
 *
 * Walk rules match `listToolFiles` (src/tools/registry.ts): dot-directories and
 * `node_modules` are skipped. `.steptix-codebehind-cache/` sits beside the skill
 * files, recordings and all, and a `node_modules` under a mis-configured
 * `skillsDir` is a second-long walk — on every keystroke, since completion
 * calls this per request.
 *
 * Names are filtered to segments the grammar can lex (`[\w-]+`), so a folder
 * called `e2e flows` or `v1.2` never yields a completion that fails to parse.
 *
 * Each directory read is guarded independently, so one unreadable subfolder
 * costs its own entries and not the whole list.
 */
export function collectSkillNames(skillsDir: string): string[] {
  const names: string[] = [];
  walkSkills(skillsDir, '', new Set(), names);
  names.sort();
  return names;
}

function walkSkills(dir: string, prefix: string, visited: Set<string>, out: string[]): void {
  // One visit per REAL directory. Because the walk follows symlinked
  // directories (see entryKind), the same real directory can be reachable
  // under many prefixes — and a link to an ancestor makes that infinite. A
  // depth cap is not enough: it bounds depth, not branching, and two
  // self-referential links make the walk O(links^depth) (measured at minutes).
  // The realpath set kills the loop, the fan-out, and duplicate names at once;
  // whichever prefix reaches a directory first owns its names, and every
  // offered spelling still resolves at runtime.
  let real: string;
  try {
    // `.native` — the libuv resolver is ~5x cheaper than the JS one, which
    // re-lstats every path component and measured as three quarters of the
    // whole walk's cost. Junction/loop semantics verified identical.
    real = fs.realpathSync.native(dir);
  } catch {
    return;
  }
  if (visited.has(real) || visited.size >= MAX_SKILL_DIRS) return;
  visited.add(real);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dot-entries are never skills. `node_modules` is checked before the
    // symlink stat below, since npm materialises `file:` deps as junctions and
    // following one is the expensive case this skip exists to avoid.
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const kind = entryKind(dir, entry);
    if (kind === 'dir') {
      if (!SEGMENT_RE.test(entry.name)) continue;
      walkSkills(path.join(dir, entry.name), `${prefix}${entry.name}/`, visited, out);
    } else if (kind === 'file' && entry.name.endsWith('.md')) {
      const base = entry.name.slice(0, -3);
      if (!SEGMENT_RE.test(base)) continue;
      out.push(`${prefix}${base}`);
    }
  }
}

/**
 * Whether a directory entry is a directory, a file, or neither.
 *
 * `readdir`'s dirents are `lstat`-flavoured, so a symlink answers `false` to
 * BOTH `isDirectory()` and `isFile()` — a symlinked skill file would silently
 * vanish from completion. Symlinks are therefore resolved with a following
 * `statSync`, guarded because a broken link throws.
 */
function entryKind(dir: string, entry: fs.Dirent): 'dir' | 'file' | null {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return null;
  try {
    const stat = fs.statSync(path.join(dir, entry.name));
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
  } catch {
    /* broken link — nothing to offer */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invocation-line reading — which lines ARE invocations, extracted from
// definition-provider.ts for the same testability reason as the resolvers.
// ---------------------------------------------------------------------------

/** A `[skill: ...]` / `[tool: ...]` invocation located on a line. */
export interface InvocationLine {
  kind: 'skill' | 'tool';
  name: string;
  /** [start, end) char range of the name token on the line. */
  nameRange: [number, number];
  /** Each `out.<key>` alias key found, with the char range of `<key>`. */
  outputKeys: Array<{ text: string; range: [number, number] }>;
}

// The name class admits `/` because both kinds are path-qualified: skills may
// live in subfolders of `skillsDir` (`auth/login`, leading slash tolerated) and
// a tool ref names a file plus the tool inside it (`auth/login/login`). Keep it
// in step with `readIdentifier`'s `allowSlash` class in
// src/parser/invocation-parser.ts. The separator mirrors that parser's finder:
// a colon with optional inline whitespace around it, or bare whitespace — the
// colon is optional (`[skill login]` ≡ `[skill: login]`), and `[skillful]`
// has neither separator so it stays prose.
/** `Sep := WS? ':' WS? | WS` and the name class, written once — the two
 *  regexes below had them character-identical and 37 lines apart, which is one
 *  edit away from F12 resolving a name the dropdown will not complete. */
const SEP = String.raw`(?:[ \t]*:[ \t]*|[ \t]+)`;
const NAME = String.raw`[A-Za-z0-9_/-]`;

const INVOCATION_RE = new RegExp(String.raw`\[(skill|tool)${SEP}(${NAME}+)`, 'g');
const OUTPUT_KEY_RE = /\bout\.([A-Za-z0-9_-]+)/g;

/**
 * Parse the invocation prefix + name + any `out.<key>` aliases out of a
 * raw line, recording character ranges so the cursor can be mapped to a
 * token. Returns null if the line is not a skill/tool invocation.
 */
export function parseInvocationLine(line: string): InvocationLine | null {
  // Every candidate, not just the first — and each one can be DECLINED, which
  // must not take the rest of the line with it. Mirrors the scan loop in
  // `parseInvocation`: `See the [skill guide](./g.md) and then [skill: login]`
  // really does call `login`, and F12 has to land on the same one the runner
  // runs.
  INVOCATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let kind: 'skill' | 'tool';
  let name: string;
  let nameStart: number;
  for (;;) {
    m = INVOCATION_RE.exec(line);
    if (m === null || m.index === undefined) return null;
    INVOCATION_RE.lastIndex = m.index + 1;
    kind = m[1] as 'skill' | 'tool';
    name = m[2]!;
    // The name starts after the `[skill`/`[tool` keyword and the separator the
    // regex consumed; recompute its offset from the full match length.
    nameStart = m.index + m[0].length - name.length;
    const after = line.slice(nameStart + name.length);
    // The parser accepts only whitespace or `]` after a name, and declines a
    // markdown link outright. Without these two the editor claimed prose the
    // runner does not: `Verify the [skill level: expert] badge` navigated to a
    // skill named `level`, and `[skill guide](./g.md)` to one named `guide`.
    if (!/^[ \t\]]/.test(after)) continue;
    if (after.startsWith('](')) continue;
    break;
  }
  const nameRange: [number, number] = [nameStart, nameStart + name.length];

  const outputKeys: InvocationLine['outputKeys'] = [];
  OUTPUT_KEY_RE.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = OUTPUT_KEY_RE.exec(line)) !== null) {
    const key = om[1]!;
    const keyStart = om.index + om[0].length - key.length;
    outputKeys.push({ text: key, range: [keyStart, keyStart + key.length] });
  }

  return { kind, name, nameRange, outputKeys };
}

// The cursor sits inside an OPEN `[skill` token: keyword, separator (the
// colon is optional, same rule as the tokenizer's finder), then a partial
// name that is still a valid name prefix — anchored to the cursor, so a
// closed call earlier on the line (`[skill: x] then [skill au│`) can't
// satisfy it and a complete call (`[skill: x]│`) no longer does. Once the
// author types anything the name grammar can't lex (a space onto args, the
// closing `]`), the anchor breaks and completion goes quiet.
const OPEN_SKILL_NAME_RE = new RegExp(String.raw`\[skill${SEP}(${NAME}*)$`);

/**
 * The partial skill name being typed at the end of `linePrefix` (the text
 * before the cursor), or `null` when the cursor is not inside an open
 * `[skill` token. `replaceStart` is the 0-based column where the partial
 * begins — equal to the cursor column while the partial is still empty — so a
 * completion item can replace exactly what was typed.
 *
 * `replaceStart`, not `start`: `refContextAt` and `paramContextAt` in
 * env-data-completion-core.ts are the same shape and already use that name,
 * and a third spelling of one concept leaves the next completion surface with
 * two precedents and no canonical one.
 */
export function openSkillNamePrefix(
  linePrefix: string,
): { partial: string; replaceStart: number } | null {
  const m = OPEN_SKILL_NAME_RE.exec(linePrefix);
  if (!m) return null;
  const partial = m[1]!;
  return { partial, replaceStart: linePrefix.length - partial.length };
}

// ---------------------------------------------------------------------------
// Argument-position reading — where in an open skill call the cursor sits,
// and which parameters the call has already passed. Backs parameter
// completion (stories/specs/skill-arg-completion.md).
// ---------------------------------------------------------------------------

/** The cursor sits at an argument-name position of an open `[skill` call. */
export interface OpenSkillArgs {
  /** The call's skill name, exactly as written (leading slash and all). */
  skillName: string;
  /** The partial argument token being typed — possibly starting `out.` —
   *  or `''` at a fresh position after whitespace. */
  partial: string;
  /** 0-based column where `partial` begins (=== cursor when empty). */
  replaceStart: number;
  /** Parameter names already passed, bare or `name=…`, on EITHER side of
   *  the cursor — so the dropdown only offers what is left to pass. */
  usedParams: Set<string>;
  /** `out.<name>` keys already present, both sides of the cursor. */
  usedOuts: Set<string>;
}

/** `[skill` + separator + a complete name — the head of a call whose
 *  argument region the walker below then follows. */
const CALL_HEAD_RE = new RegExp(String.raw`\[skill${SEP}(${NAME}+)`, 'g');

type ArgWalk =
  | { kind: 'closed'; at: number; used: string[]; outs: string[] }
  | { kind: 'blocked'; used: string[]; outs: string[] }
  | {
      kind: 'at-arg';
      partial: string;
      replaceStart: number;
      used: string[];
      outs: string[];
    };

/**
 * Walk a call's argument region from `i` toward `cursor`, mirroring the
 * runner's scanner: skip inline space, identifier (optionally `out.`-
 * prefixed), optional `=` + (quoted string | `[...]` array with quote-aware
 * depth | bare literal), repeat. Argument text can contain whitespace, `]`
 * and `[` inside quotes and array literals, which is why this is a walk and
 * not a regex.
 *
 * `cursor = Infinity` turns it into a pure collector — how the caller
 * gathers the used names AFTER the cursor, up to the call's real `]`.
 */
function walkArgs(line: string, i: number, cursor: number): ArgWalk {
  const used: string[] = [];
  const outs: string[] = [];
  // A completed value must be followed by whitespace before the next
  // argument (the scanner errors otherwise), so a cursor glued to the end
  // of one (`role="admin"│`) is not an argument position.
  let sepSeen = true;
  for (;;) {
    const preSkip = i;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i > preSkip) sepSeen = true;
    if (i >= cursor) {
      if (!sepSeen) return { kind: 'blocked', used, outs };
      return { kind: 'at-arg', partial: '', replaceStart: cursor, used, outs };
    }
    if (i >= line.length) return { kind: 'blocked', used, outs };
    if (line[i] === ']') return { kind: 'closed', at: i, used, outs };

    // Argument token: optional `out.` (exact, as the scanner's tryConsume),
    // then a plain-identifier name — `readIdentifier()` with no options, so
    // no hyphen and no slash.
    const tokStart = i;
    const isOut = line.startsWith('out.', i);
    if (isOut) i += 4;
    const idStart = i;
    while (i < line.length && /\w/.test(line[i]!)) i++;
    if (i === idStart && !isOut) {
      // Something the grammar never puts at an argument position (a quote,
      // a stray `=`…). The parser errors here; completion stays quiet.
      return { kind: 'blocked', used, outs };
    }
    if (cursor <= i) {
      if (!sepSeen) return { kind: 'blocked', used, outs };
      return {
        kind: 'at-arg',
        partial: line.slice(tokStart, cursor),
        replaceStart: tokStart,
        used,
        outs,
      };
    }
    const name = line.slice(idStart, i);

    if (line[i] === '=') {
      i++;
      // Right after `=` a VALUE is expected, never an argument name.
      if (cursor <= i) return { kind: 'blocked', used, outs };
      const v = line[i];
      if (v === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i++;
        // Inside the quotes (an unterminated one runs to end-of-line and
        // swallows the cursor with it — correct: the author is mid-value).
        if (cursor <= i) return { kind: 'blocked', used, outs };
        i++;
      } else if (v === '[') {
        // Array literal — bracket depth with quote awareness, mirroring
        // readBracketedLiteral, so `ids=["a ]", 2]` neither closes the
        // call nor ends the value early.
        let depth = 0;
        let inStr = false;
        let esc = false;
        while (i < line.length) {
          const ch = line[i]!;
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === '[') depth++;
          else if (ch === ']') {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        if (cursor < i) return { kind: 'blocked', used, outs };
      } else {
        // Bare literal (number / boolean) — runs to whitespace or `]`. A
        // cursor at its end is still typing the value.
        while (i < line.length && line[i] !== ' ' && line[i] !== '\t' && line[i] !== ']') i++;
        if (cursor <= i) return { kind: 'blocked', used, outs };
      }
    }

    (isOut ? outs : used).push(name);
    sepSeen = false;
  }
}

/**
 * The argument-name position the cursor occupies in an open `[skill` call on
 * `line`, or `null` when it occupies none: still inside the name (name
 * completion owns that), inside a quoted / array / bare value, right after
 * `=`, glued to a finished value, or in no call at all. Used names are
 * collected from BOTH sides of the cursor, so editing the middle of
 * `[skill login │ role="admin"]` still excludes `role`.
 */
export function openSkillArgsContext(line: string, cursor: number): OpenSkillArgs | null {
  CALL_HEAD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_HEAD_RE.exec(line)) !== null && m.index < cursor) {
    CALL_HEAD_RE.lastIndex = m.index + 1;
    const skillName = m[1]!;
    const nameEnd = m.index + m[0].length;
    // Cursor still inside (or at the end of) the name token: the name
    // completion surface owns it.
    if (cursor <= nameEnd) return null;

    const walk = walkArgs(line, nameEnd, cursor);
    if (walk.kind === 'closed') {
      // This call ends before the cursor — scan on for a later one.
      CALL_HEAD_RE.lastIndex = walk.at + 1;
      continue;
    }
    if (walk.kind === 'blocked') return null;

    // Also collect what sits between the cursor and the call's real `]`,
    // so already-passed arguments to the RIGHT of the cursor drop out too.
    const after = walkArgs(line, cursor, Infinity);
    return {
      skillName,
      partial: walk.partial,
      replaceStart: walk.replaceStart,
      usedParams: new Set([...walk.used, ...after.used]),
      usedOuts: new Set([...walk.outs, ...after.outs]),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill parameters/outputs — what a call site may pass, read from the skill
// file with the same rules the runner uses.
// ---------------------------------------------------------------------------

export interface SkillIo {
  /** Declared parameters, in file order. `value` is the bullet's literal
   *  text after the colon — a default like `$SB_PASSWORD` or a description
   *  — NEVER resolved through the env, so no secret can reach a dropdown. */
  params: Array<{ name: string; value: string }>;
  /** Declared output names the invocation grammar can lex (`\w+`). */
  outputs: string[];
}

/** `- name` / `- name: description` bullets under `## Outputs`. Mirrors
 *  `extractOutputs` (src/parser/markdown.ts), which tolerates the bare form
 *  `parseParameters` doesn't, with `parseSection`'s heading rules: the
 *  section is `#{2,}` case-insensitive and ends at the next heading of the
 *  same or shallower depth. */
function parseOutputs(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  let sectionDepth = 0;
  for (const raw of lines) {
    const heading = /^(#{2,})\s+(\S.*?)\s*$/.exec(raw);
    if (heading) {
      const depth = heading[1]!.length;
      if (inSection && depth <= sectionDepth) break;
      if (!inSection && heading[2]!.toLowerCase() === 'outputs') {
        inSection = true;
        sectionDepth = depth;
      }
      continue;
    }
    if (!inSection) continue;
    const item = /^\s*-\s+(.+?)\s*$/.exec(raw);
    if (!item) continue;
    const textPart = item[1]!;
    const colon = textPart.indexOf(':');
    const name = (colon === -1 ? textPart : textPart.slice(0, colon)).trim();
    // Only names an `out.<key>` can lex — same never-offer-what-cannot-parse
    // rule collectSkillNames applies to file names.
    if (/^\w+$/.test(name)) out.push(name);
  }
  return out;
}

const skillIoCache = new Map<string, { mtimeMs: number; size: number; io: SkillIo }>();

/**
 * The parameters and outputs of the skill named `name` under `skillsDir`, or
 * `null` when the name is malformed or the file is missing/unreadable.
 * Parameters come from runner-core's `parseParameters` — the parser the
 * `{{}}` completion already trusts for server parity. Cached on mtime+size:
 * the argument walker runs per keystroke while typing inside a call.
 */
export function skillIoFor(skillsDir: string, name: string): SkillIo | null {
  const rel = canonicalSkillName(name);
  if (rel === null) return null;
  const file = path.resolve(skillsDir, `${rel}.md`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = skillIoCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.io;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const io: SkillIo = {
    params: Object.entries(parseParameters(text)).map(([n, value]) => ({ name: n, value })),
    outputs: parseOutputs(text),
  };
  skillIoCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, io });
  return io;
}

// ---------------------------------------------------------------------------
// The surface switches, as completion rows
// ---------------------------------------------------------------------------

/**
 * One bracket-directive completion offered at the start of a step, as plain
 * data. The provider maps these onto `vscode.CompletionItem`.
 *
 * Plain data rather than items built in `section-providers.ts` for the reason
 * `section-diagnostics-core.ts` exists: the DECISION — which tokens are
 * offered and what they are labelled — is then unit-testable under
 * `node --test`, which cannot load the `vscode` module.
 */
export interface DirectiveCompletion {
  /** The label, and the text inserted unless {@link insert} says otherwise. */
  token: string;
  detail: string;
  documentation: string;
  /**
   * What to insert when it differs from the label, as a VS Code snippet
   * (`$0` is where the caret lands). Only `[use ai]` needs one: it is a
   * prefix, so the caret belongs after it, where the step is written.
   */
  insert?: string;
}

/** The token that opens a `[use ai]` step, as the completion offers it. */
export const USE_AI_TOKEN = '[use ai]';

/**
 * `[use computer]` and `[use browser]`, in that order
 * (docs/specs/SPEC-use-computer.md §10.3), then `[use ai]`
 * (stories/use-ai-step.md).
 *
 * The surfaces are derived from runner-core's `USE_SURFACES` rather than typed
 * out, so the dropdown cannot offer a spelling the grammar refuses — the
 * property every other mirror in this file is written for. §4.2 makes that
 * matter more than it used to: a near miss like `[computer]` is now a parse
 * ERROR rather than prose, so the list is what stops an author guessing.
 *
 * `[use ai]` is last and labelled for what it does — it switches nothing, so
 * "surface switch" would be a false thing to tell an author about it.
 */
export function useDirectiveCompletions(): DirectiveCompletion[] {
  return [
    ...USE_SURFACES.map((surface) => ({
      token: `[use ${surface}]`,
      detail: 'surface switch',
      documentation:
        surface === 'computer'
          ? "Drive the operating system's screen from here on — windows, dialogs " +
            'and menus — answered from a screenshot rather than the page.'
          : 'Return to the page: DOM snapshots and Playwright, on the tab the ' +
            'test left.',
    })),
    {
      token: USE_AI_TOKEN,
      detail: 'ask the model for a value',
      documentation:
        'Ask the model for a value and store it: `[use ai] Create a name starting ' +
        'with AUTO [store as: name]`. The model sees the step text and nothing ' +
        'else — no page, no earlier steps, no date — so put what it needs in the ' +
        'step. It is asked again on every run and never compiled; for a ' +
        'value that must be the same every time, write a `[tool:]`.',
      insert: `${USE_AI_TOKEN} $0`,
    },
  ];
}

/**
 * What kind of line the debugger's Step Into is parked on — the decision
 * behind `pausedLineKind` in `commands/index.ts`, and the only thing that
 * decides which one-shot flag (if any) an F11 sends.
 *
 * Delegates to `parseInvocationLine` rather than matching `[tool:` itself:
 * that parser mirrors the runner's grammar, where the colon is OPTIONAL
 * (`[tool echo]` ≡ `[tool: echo]`) and a markdown link or prose like
 * `[skill level: expert]` is declined. A local regex would disagree with the
 * runner on exactly those lines — and disagreeing here means arming the
 * code-behind flag on a line the server is about to dispatch as a tool.
 *
 * `parseUseStep` is asked on the same terms and for the same reason — it is
 * runner-core's mirror of the grammar the server runs, not a look-alike. It is
 * asked FIRST only because it is the cheaper test; the two grammars cannot
 * both claim a line, since `[use` is not an invocation keyword.
 *
 * `'use'` is the NON-STEPPABLE answer (docs/specs/SPEC-use-computer.md §10.3):
 * a surface switch is dispatched by the run loop with no model call, and §9
 * excludes it from compilation outright, so there is no code-behind entry for
 * `pauseAtNextCodeBehind` to pause at and no "into" for F11 to take. Under
 * `'plain'` the flag was harmless but misleading — F11 degraded silently to an
 * ordinary step pause.
 *
 * A `[use ai] <step>` line is `'use'` too (stories/use-ai-step.md): it asks
 * the model and nothing else, is never compiled, so there is no code-behind
 * entry for Step Into to pause in — and under `'plain'` F11 would arm exactly
 * that flag, on a line that can never have one. Asked before the invocation
 * parser for a second reason: `parseInvocation` reads text in front of a token
 * as a LABEL, so `[use ai] Pick a name [tool: x]`-shaped prose could otherwise
 * classify as a tool line the runner never dispatches.
 *
 * The text arrives with its `N. ` ordinal still on it (every caller reads it
 * straight off the editor), so the prefix is stripped here. `parseUseStep`
 * and `parseUseAiStep` normalise the `[no-hooks]` marker themselves.
 */
export function classifyDebuggableLine(text: string): 'tool' | 'skill' | 'plain' | 'use' {
  const instruction = text.replace(/^\s*\d+\.\s+/, '');
  if (parseUseStep(instruction) || parseUseAiStep(instruction)) return 'use';
  return parseInvocationLine(text)?.kind ?? 'plain';
}
