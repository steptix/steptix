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
 * Load all .md files from a single directory.
 * Files are discovered recursively and sorted alphabetically.
 * Returns an empty array if the directory does not exist.
 */
async function loadMdFilesFromDir(dir: string): Promise<LoadedContext['files']> {
  const absDir = path.resolve(dir);

  try {
    await fs.access(absDir);
  } catch {
    logger.debug(`Context directory not found: ${absDir}`);
    return [];
  }

  const { glob } = await import('glob');
  const filePaths = await glob('**/*.md', {
    cwd: absDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });

  filePaths.sort();

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

  return files;
}

/**
 * Load all .md files from the context directory and any additional
 * directories specified by the ADDITIONAL_CONTEXT_DIR env var
 * (comma-delimited paths).
 *
 * Returns empty context if no directories contain .md files.
 */
export async function loadContextFiles(contextDir: string): Promise<LoadedContext> {
  const allFiles: LoadedContext['files'] = [];

  // Primary context directory
  const primaryFiles = await loadMdFilesFromDir(contextDir);
  if (primaryFiles.length > 0) {
    logger.info(`Loading ${primaryFiles.length} context file(s) from ${path.resolve(contextDir)}`);
    allFiles.push(...primaryFiles);
  }

  // Additional context directories from ADDITIONAL_CONTEXT_DIR env var
  const additionalDirs = process.env['ADDITIONAL_CONTEXT_DIR'];
  if (additionalDirs) {
    const dirs = additionalDirs
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    for (const dir of dirs) {
      const files = await loadMdFilesFromDir(dir);
      if (files.length > 0) {
        logger.info(`Loading ${files.length} additional context file(s) from ${path.resolve(dir)}`);
        allFiles.push(...files);
      }
    }
  }

  if (allFiles.length === 0) {
    logger.debug('No context files found');
    return { combined: '', files: [] };
  }

  const combined = allFiles
    .map(({ relativePath, content }) => `### Context: ${relativePath}\n\n${content}`)
    .join('\n\n---\n\n');

  return { combined, files: allFiles };
}
