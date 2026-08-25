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
 *
 * A mirror that drifts is worse than no mirror: F12 would open a different file
 * from the one the runner loads, and completion would offer names the parser
 * rejects. `tests/invocation-target-core.test.js` pins the parity rows against
 * the canonical implementations' own test tables.
 *
 * The one place the editor is deliberately MORE lenient than the parser is a
 * half-typed reference: an author mid-keystroke on `auth/login/` has not made
 * an error yet, so navigation still resolves the file they are heading for.
 * Genuine malformations (an interior `//`) return `null` and the caller warns —
 * the editor must never bless a name the runner will reject.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Extensions a tool file may carry, in the order the registry probes them.
 * Mirrors `TOOL_FILE_EXTS` in src/tools/registry.ts.
 */
export const TOOL_FILE_EXTS = ['.ts', '.mts', '.js', '.mjs'] as const;

/** A path segment the invocation grammar can actually lex: `[\w-]+`, matching
 *  `readIdentifier`'s class in src/parser/invocation-parser.ts. */
const SEGMENT_RE = /^[\w-]+$/;

/**
 * How deep the skills walk will follow directories. Only reachable via
 * symlinked directories (which this walk follows, unlike a plain `isDirectory`
 * check) — a link pointing at an ancestor would otherwise recurse forever, and
 * this runs on every completion keystroke.
 */
const MAX_SKILL_DEPTH = 16;

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
 * Two deliberate leniencies, because this is navigation rather than execution:
 *
 *  - a leading `/` is stripped (`parseToolRef` would throw);
 *  - a TRAILING `/` means the author is still typing, so only that empty
 *    segment is dropped and the remaining segments are the file —
 *    `auth/login/` → `auth/login`, the file they are heading into. The
 *    last-segment-is-the-tool rule is deliberately NOT applied to a
 *    still-typing ref, which is what makes this land one directory deeper than
 *    a naive "drop all empty segments" filter would.
 *
 * An INTERIOR empty segment (`auth//login`) is a real malformation with no
 * plausible target, so it returns `null` and the caller warns.
 */
export function toolFileFor(ref: string): string | null {
  const stripped = ref.startsWith('/') ? ref.slice(1) : ref;
  const stillTyping = stripped.endsWith('/');
  const segments = stripped.split('/');
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
 * `node_modules` are skipped. `.aiui-codebehind-cache/` sits beside the skill
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
  walkSkills(skillsDir, '', 0, names);
  names.sort();
  return names;
}

function walkSkills(dir: string, prefix: string, depth: number, out: string[]): void {
  if (depth > MAX_SKILL_DEPTH) return;
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
      walkSkills(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1, out);
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
