import matter from 'gray-matter';
import type { TestFrontmatter } from './types.js';

/** Parse YAML frontmatter from a Markdown file's raw content */
export function parseFrontmatter(rawContent: string): {
  frontmatter: TestFrontmatter;
  body: string;
} {
  const parsed = matter(rawContent);

  const data = parsed.data as Record<string, unknown>;

  // Normalise tags: accept string or array
  let tags: string[] = [];
  if (Array.isArray(data['tags'])) {
    tags = (data['tags'] as unknown[]).map(String);
  } else if (typeof data['tags'] === 'string') {
    tags = (data['tags'] as string).split(',').map((t) => t.trim()).filter(Boolean);
  }

  const timeoutVal = typeof data['timeout'] === 'string' ? data['timeout'] : undefined;
  const dataFileVal = typeof data['dataFile'] === 'string' ? data['dataFile'] : undefined;
  const envVal = typeof data['env'] === 'string' ? data['env'] : undefined;
  const typeRaw = typeof data['type'] === 'string' ? data['type'] : undefined;
  const typeVal = typeRaw === 'skill' || typeRaw === 'test' ? typeRaw : undefined;
  const dataSourcesVal = parseDataSources(data['dataSources']);

  const frontmatter: TestFrontmatter = {
    tags,
    ...(timeoutVal !== undefined && { timeout: timeoutVal }),
    ...(dataFileVal !== undefined && { dataFile: dataFileVal }),
    ...(envVal !== undefined && { env: envVal }),
    ...(typeVal !== undefined && { type: typeVal }),
    ...(dataSourcesVal !== undefined && { dataSources: dataSourcesVal }),
  };

  return {
    frontmatter,
    body: parsed.content,
  };
}

/** Names reserved for the built-in interpolation namespaces. */
const RESERVED_DATA_SOURCE_NAMES = new Set(['env', 'data']);
/** A `dataSources` key must look like a JS identifier so it can be safely spliced into the interpolation regex. */
const DATA_SOURCE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a frontmatter `dataSources` value into a clean
 * `Record<string, string>`. Returns `undefined` when the field is absent so
 * the optional-property shape on `TestFrontmatter` stays clean. Throws on any
 * shape violation — callers see the error at parse time.
 */
function parseDataSources(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Frontmatter `dataSources` must be a map of name → file path.');
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (RESERVED_DATA_SOURCE_NAMES.has(name)) {
      throw new Error(
        `Frontmatter \`dataSources\` cannot use the reserved name "${name}" — ` +
        `'env' and 'data' are the built-in namespaces.`,
      );
    }
    if (!DATA_SOURCE_NAME_RE.test(name)) {
      throw new Error(
        `Frontmatter \`dataSources\` name "${name}" is invalid — ` +
        `must match /^[A-Za-z_][A-Za-z0-9_]*$/ (start with a letter or underscore).`,
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Frontmatter \`dataSources.${name}\` must be a non-empty file-path string.`,
      );
    }
    out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
