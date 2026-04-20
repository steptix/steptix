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
  const typeRaw = typeof data['type'] === 'string' ? data['type'] : undefined;
  const typeVal = typeRaw === 'skill' || typeRaw === 'test' ? typeRaw : undefined;

  const frontmatter: TestFrontmatter = {
    tags,
    ...(timeoutVal !== undefined && { timeout: timeoutVal }),
    ...(dataFileVal !== undefined && { dataFile: dataFileVal }),
    ...(typeVal !== undefined && { type: typeVal }),
  };

  return {
    frontmatter,
    body: parsed.content,
  };
}
