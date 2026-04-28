/**
 * Minimal parser for the `## Config` and `## Parameters` sections of a
 * TestBench markdown file. Mirrors the subset of `src/parser/markdown.ts`
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

/** Parse a section by name (case-insensitive). Returns {} if absent. */
export function parseSection(text: string, sectionName: string): SectionMap {
  const lines = text.split(/\r?\n/);
  const target = sectionName.toLowerCase();

  let inSection = false;
  let sectionDepth = 0;
  const out: SectionMap = {};

  for (const raw of lines) {
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
    const value = itemMatch[2]!;
    out[key] = value;
  }

  return out;
}

export function parseConfig(text: string): SectionMap {
  return parseSection(text, 'Config');
}

export function parseParameters(text: string): SectionMap {
  return parseSection(text, 'Parameters');
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
