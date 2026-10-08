/**
 * Minimal parser for the `## Config` and `## Parameters` sections of a
 * Steptix markdown file. Mirrors the subset of `src/parser/markdown.ts`
 * the extension actually needs at run-time, without pulling in the full
 * markdown parser (and its tokenizer dependency).
 *
 * Both sections use the same shape:
 *
 *   ## Config
 *   - baseUrl: https://github.com/
 *   - timeout: 30s
 *
 *   ## Parameters
 *   - username: $GITHUB_USERNAME
 *   - password: $GITHUB_PASSWORD
 *
 * Values starting with `$` are resolved against an env map (the parsed
 * `.env`) by `resolveValueFromEnv`.
 */

const HEADING_RE = /^(#{2,})\s+(\S.*?)\s*$/;
const ITEM_RE = /^\s*-\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/;

export type SectionMap = Record<string, string>;

/** One `- key: value` bullet located in a section's source text. */
export interface SectionItem {
  key: string;
  value: string;
  /** 0-based line index of the bullet. */
  line: number;
  /** 0-based column where the key token starts, and its length — so an
   *  editor can select exactly the key. */
  column: number;
  length: number;
}

/**
 * Scan a section's `- key: value` bullets with their source positions, in
 * file order (duplicates included — the caller decides which wins).
 *
 * `parseSection` builds its map from this, so the heading/bullet grammar and
 * the section-entry/exit rules exist exactly once: the FIRST section whose
 * name matches (case-insensitive) opens the span, and the next heading at the
 * same or shallower depth closes it.
 */
export function scanSectionItems(text: string, sectionName: string): SectionItem[] {
  const lines = text.split(/\r?\n/);
  const target = sectionName.toLowerCase();

  let inSection = false;
  let sectionDepth = 0;
  const out: SectionItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const headingMatch = HEADING_RE.exec(raw);
    if (headingMatch) {
      const depth = headingMatch[1]!.length;
      const name = headingMatch[2]!.toLowerCase();
      if (inSection && depth <= sectionDepth) {
        // Section ended.
        break;
      }
      if (!inSection && name === target) {
        inSection = true;
        sectionDepth = depth;
      }
      continue;
    }
    if (!inSection) continue;

    const itemMatch = ITEM_RE.exec(raw);
    if (!itemMatch) continue;
    const key = itemMatch[1]!;
    // ITEM_RE anchors the key after `\s*-\s+`, so nothing but whitespace and
    // the bullet marker precedes it and indexOf finds its exact column.
    out.push({ key, value: itemMatch[2]!, line: i, column: raw.indexOf(key), length: key.length });
  }

  return out;
}

/** Parse a section by name (case-insensitive). Returns {} if absent.
 *  A duplicated key takes its LAST value, the way the scan order lands. */
export function parseSection(text: string, sectionName: string): SectionMap {
  const out: SectionMap = {};
  for (const { key, value } of scanSectionItems(text, sectionName)) out[key] = value;
  return out;
}

export function parseConfig(text: string): SectionMap {
  return parseSection(text, 'Config');
}

export function parseParameters(text: string): SectionMap {
  return parseSection(text, 'Parameters');
}

/**
 * The test's `## Context` section, as written and trimmed, or undefined when
 * the file has none (docs/specs/SPEC-web-survey-fixes.md §2.46). Free text,
 * not bullets: everything from the heading to the next level-1 or level-2
 * heading, deeper headings included, the same span `src/parser/markdown.ts`
 * keeps. A `#` line inside a fenced code block is code, not a heading.
 */
export function parseContext(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let inSection = false;
  let fence: string | null = null;

  for (const raw of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(raw);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      if (inSection) kept.push(raw);
      continue;
    }
    if (fence === null) {
      const heading = /^(#{1,6})\s+(\S.*?)\s*#*\s*$/.exec(raw);
      if (heading && heading[1]!.length <= 2) {
        if (inSection) break;
        if (heading[1]!.length === 2 && heading[2]!.toLowerCase() === 'context') inSection = true;
        continue;
      }
    }
    if (inSection) kept.push(raw);
  }

  const context = kept.join('\n').trim();
  return context === '' ? undefined : context;
}

/**
 * Resolve a value like `$GITHUB_USERNAME` or a literal string. Variables
 * not present in `env` are returned unchanged so the user gets a clear
 * downstream error rather than a silent empty string.
 */
export function resolveValueFromEnv(value: string, env: Record<string, string>): string {
  if (!value.startsWith('$')) return value;
  const varName = value.slice(1);
  return env[varName] ?? value;
}

/** Resolve every value in a SectionMap against `env`. */
export function resolveSection(section: SectionMap, env: Record<string, string>): SectionMap {
  const out: SectionMap = {};
  for (const [k, v] of Object.entries(section)) {
    out[k] = resolveValueFromEnv(v, env);
  }
  return out;
}
