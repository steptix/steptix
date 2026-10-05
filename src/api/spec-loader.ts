import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

/** Shape of a cached spec file stored on disk */
interface CachedSpec {
  url: string;
  cachedAt: string;
  spec: unknown;
}

export interface SpecSummary {
  name: string;
  url: string;
  filePath: string;
  cachedAt: string;
}

/**
 * Download a spec from the given URL (resolving $ENV_VAR references) and cache it to disk.
 * The cache file is named from the URL so different environments don't conflict.
 */
export async function downloadSpec(url: string, specsDir: string): Promise<unknown> {
  const resolvedUrl = resolveEnvVars(url);

  logger.info(`Downloading spec from ${resolvedUrl}...`);

  const response = await fetch(resolvedUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download spec from ${resolvedUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const spec = await response.json() as unknown;

  await fs.mkdir(path.resolve(specsDir), { recursive: true });

  const fileName = urlToFileName(resolvedUrl);
  const filePath = path.resolve(specsDir, fileName);

  const cached: CachedSpec = {
    url: resolvedUrl,
    cachedAt: new Date().toISOString(),
    spec,
  };

  await fs.writeFile(filePath, JSON.stringify(cached, null, 2), 'utf-8');
  logger.info(`Spec cached: ${path.relative(process.cwd(), filePath)}`);

  return spec;
}

/**
 * Load a spec from the disk cache by its original URL.
 * Returns undefined if no cache file exists.
 */
export async function loadCachedSpec(url: string, specsDir: string): Promise<unknown | undefined> {
  const resolvedUrl = resolveEnvVars(url);
  const fileName = urlToFileName(resolvedUrl);
  const filePath = path.resolve(specsDir, fileName);

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const cached = JSON.parse(raw) as CachedSpec;
    return cached.spec;
  } catch {
    return undefined;
  }
}

/**
 * Return a spec, using the disk cache if available or downloading if not.
 */
export async function getSpec(url: string, specsDir: string): Promise<unknown> {
  const cached = await loadCachedSpec(url, specsDir);
  if (cached !== undefined) {
    logger.debug(`Using cached spec for ${url}`);
    return cached;
  }
  return downloadSpec(url, specsDir);
}

/**
 * List all cached specs in the specs directory with their metadata.
 */
export async function listCachedSpecs(specsDir: string): Promise<SpecSummary[]> {
  const absDir = path.resolve(specsDir);

  try {
    await fs.access(absDir);
  } catch {
    return [];
  }

  const entries = await fs.readdir(absDir);
  const summaries: SpecSummary[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    const filePath = path.join(absDir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const cached = JSON.parse(raw) as CachedSpec;
      summaries.push({
        name: entry.replace(/\.json$/, ''),
        url: cached.url,
        filePath,
        cachedAt: cached.cachedAt,
      });
    } catch {
      // Skip malformed cache files
    }
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/**
 * Extract spec URL references from all context files combined content.
 * Returns unique URLs found in "Spec URL: <url>" patterns.
 */
export function extractSpecUrlsFromContext(contextContent: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  const pattern = /spec\s+url\s*:\s*(\S+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(contextContent)) !== null) {
    const url = match[1] ?? '';
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

/** Convert a URL to a safe filename (strip protocol, replace special chars) */
function urlToFileName(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9-_.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 120) + '.json';
}

/** Resolve $ENV_VAR references in a string from process.env */
function resolveEnvVars(str: string): string {
  return str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name: string) => {
    return process.env[name] ?? `$${name}`;
  });
}
