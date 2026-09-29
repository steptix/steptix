/**
 * Minimal YAML frontmatter parser scoped to the fields Steptix actually
 * reads. Not a full YAML implementation — we only need `type`, `disabled`,
 * `env`, `tags`, and the `# Heading` line that follows the frontmatter.
 *
 * Targeted regex over the frontmatter span keeps the dependency surface
 * zero and avoids pulling a YAML lib into both the extension bundle and
 * the runner-core CLI.
 */

export interface TestFrontmatter {
  /** `type: skill` marks the file as a reusable building block, not a test. */
  type?: string;
  /** `disabled: true` removes the file from discovery (long-term skip). */
  disabled?: boolean;
  /** `env: <name>` pins this test to a specific env in batch runs. */
  env?: string;
  /** `tags: [smoke, slow]` surface as TestItem tags for filter / run-by-tag. */
  tags?: string[];
  /**
   * `dataSources:` block mapping (name → path). Forwarded to the server so
   * test-level `${<name>.X}` named data sources resolve on the server path,
   * not just the CLI parse path. Block style only:
   *   dataSources:
   *     catalog: ../data/catalog.json
   */
  dataSources?: Record<string, string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Parse the YAML frontmatter at the top of a markdown file. Returns an
 * empty object if there's no frontmatter or it's malformed.
 *
 * Recognises the four fields Steptix uses; anything else in the
 * frontmatter is ignored. Unknown keys do not produce errors — this
 * parser is intentionally tolerant so users can add their own metadata.
 */
export function parseFrontmatter(text: string): TestFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return {};
  const body = match[1] ?? '';
  const out: TestFrontmatter = {};

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? '');
    if (!line.trim()) continue;

    // Only top-level (non-indented) keys are matched here; indented lines are
    // block-mapping children, consumed by their parent key's handler.
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const valueRaw = (m[2] ?? '').trim();

    switch (key) {
      case 'type':
        out.type = unquote(valueRaw);
        break;
      case 'disabled':
        out.disabled = parseBool(valueRaw);
        break;
      case 'env':
        out.env = unquote(valueRaw);
        break;
      case 'dataSources': {
        // Block mapping only: `dataSources:` on its own line, followed by
        // indented `name: path` children. Inline/flow form isn't supported
        // (the core parser doesn't emit it either). Consume the indented run.
        if (valueRaw) break;
        const sources: Record<string, string> = {};
        let j = i + 1;
        for (; j < lines.length; j++) {
          const childRaw = lines[j] ?? '';
          if (!childRaw.trim()) continue; // tolerate blank lines within the block
          if (!/^\s/.test(childRaw)) break; // dedent → block ends
          // Name rule matches the CLI's DATA_SOURCE_NAME_RE (no hyphens) so a
          // source name that parses here also validates on the CLI path.
          const cm = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(stripComment(childRaw));
          if (cm) {
            const cval = unquote((cm[2] ?? '').trim());
            if (cval) sources[cm[1]!] = cval;
          }
        }
        i = j - 1; // resume after the consumed block
        if (Object.keys(sources).length > 0) out.dataSources = sources;
        break;
      }
      case 'tags': {
        // Normalize tags to lowercase so case mismatches between two
        // tests (`[Smoke]` vs `[smoke]`) don't produce two separate VS
        // Code TestTags. Run-by-tag filtering is much more useful when
        // it's case-insensitive. Display still shows whatever the parser
        // returned, which is now also lowercase — acceptable trade-off
        // for reliable matching.
        const tags = parseInlineList(valueRaw).map((t) => t.toLowerCase());
        if (tags.length > 0) out.tags = tags;
        break;
      }
      default:
        // Unknown key — ignore.
        break;
    }
  }

  return out;
}

/**
 * Extract the first `# Heading` line from the markdown, used for the
 * TestItem display label. Returns null when absent.
 *
 * Frontmatter (if any) is skipped before scanning.
 */
export function parseTitleHeading(text: string): string | null {
  const trimmed = stripFrontmatter(text);
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!;
    // Stop scanning at the first non-blank non-`#` line — the title must
    // come before any prose. This avoids matching a `#` inside a code
    // block 50 lines down.
    if (!line.startsWith('#')) return null;
  }
  return null;
}

function stripFrontmatter(text: string): string {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return text;
  return text.slice(match[0].length);
}

function stripComment(line: string): string {
  // YAML `#` comment — preserve `#` inside quoted strings.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\'' && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseBool(s: string): boolean {
  const v = unquote(s).trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Parse a flow-style YAML list: `[a, b, "c d"]`. Returns [] when the
 * value isn't a flow list (block-style `- item` lists aren't supported —
 * we don't need them for the current field set).
 */
function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\'' && !inDouble) { inSingle = !inSingle; buf += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; buf += ch; continue; }
    if (ch === ',' && !inSingle && !inDouble) {
      const item = unquote(buf.trim());
      if (item) out.push(item);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const last = unquote(buf.trim());
  if (last) out.push(last);
  return out;
}
