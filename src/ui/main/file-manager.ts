/**
 * File system operations exposed to the renderer via IPC.
 * All paths are validated to be within the project root before any operation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileTreeEntry } from '../ipc-types.js';

/** Validate that a resolved path is within the allowed root directory. */
function assertWithinRoot(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(
      `Path "${resolved}" is outside the allowed root "${resolvedRoot}"`,
    );
  }
}

/** Read a file and return its UTF-8 content. */
export async function readFile(
  filePath: string,
  root: string,
): Promise<{ content: string }> {
  assertWithinRoot(filePath, root);
  const content = await fs.readFile(path.resolve(filePath), 'utf-8');
  return { content };
}

/** Write content to a file, creating parent directories if needed. */
export async function writeFile(
  filePath: string,
  content: string,
  root: string,
): Promise<void> {
  const resolved = path.resolve(filePath);
  assertWithinRoot(resolved, root);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf-8');
}

/** Recursively list a directory and return a tree of FileTreeEntry nodes. */
export async function listDirectory(
  dir: string,
  root: string,
): Promise<{ tree: FileTreeEntry[] }> {
  assertWithinRoot(dir, root);
  const tree = await buildTree(path.resolve(dir));
  return { tree };
}

async function buildTree(dirPath: string): Promise<FileTreeEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: FileTreeEntry[] = [];

  // Sort entries: directories first, then alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // Skip hidden files and common non-test directories
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath);
      result.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children,
      });
    } else {
      result.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
      });
    }
  }

  return result;
}

/** Create an empty file, ensuring parent directories exist. */
export async function createFile(
  filePath: string,
  root: string,
): Promise<void> {
  const resolved = path.resolve(filePath);
  assertWithinRoot(resolved, root);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, '', 'utf-8');
}

/** Rename (move) a file or directory. */
export async function renameFile(
  from: string,
  to: string,
  root: string,
): Promise<void> {
  const resolvedFrom = path.resolve(from);
  const resolvedTo = path.resolve(to);
  assertWithinRoot(resolvedFrom, root);
  assertWithinRoot(resolvedTo, root);
  await fs.mkdir(path.dirname(resolvedTo), { recursive: true });
  await fs.rename(resolvedFrom, resolvedTo);
}

/** Delete a file. */
export async function deleteFile(
  filePath: string,
  root: string,
): Promise<void> {
  const resolved = path.resolve(filePath);
  assertWithinRoot(resolved, root);
  await fs.rm(resolved, { force: true });
}
