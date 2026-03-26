import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface LoadedContext {
  /** All context file contents concatenated into a single string */
  combined: string;
  /** Individual files loaded, in alphabetical order */
  files: Array<{ relativePath: string; content: string }>;
}

/**
 * Load all .md files from the context directory.
 * Files are discovered recursively and sorted alphabetically.
 * Returns empty context if the directory does not exist.
 */
export async function loadContextFiles(contextDir: string): Promise<LoadedContext> {
  const absDir = path.resolve(contextDir);

  try {
    await fs.access(absDir);
  } catch {
    logger.debug(`Context directory not found: ${absDir}`);
    return { combined: '', files: [] };
  }

  const { glob } = await import('glob');
  const filePaths = await glob('**/*.md', {
    cwd: absDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

  filePaths.sort();

  if (filePaths.length === 0) {
    logger.debug('No context files found');
    return { combined: '', files: [] };
  }

  logger.info(`Loading ${filePaths.length} context file(s) from ${absDir}`);

  const files: LoadedContext['files'] = [];

  for (const absPath of filePaths) {
    const relativePath = path.relative(absDir, absPath);
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      files.push({ relativePath, content });
      logger.debug(`  Loaded context: ${relativePath} (${content.length} chars)`);
    } catch (err) {
      logger.warn(`Could not read context file ${absPath}: ${String(err)}`);
    }
  }

  const combined = files
    .map(({ relativePath, content }) => `### Context: ${relativePath}\n\n${content}`)
    .join('\n\n---\n\n');

  return { combined, files };
}
