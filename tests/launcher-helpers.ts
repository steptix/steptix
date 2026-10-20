/**
 * Fake `steptix` packages and Steptix folders for the launcher tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layoutOf, type Layout } from '../src/launcher/runtimes.js';

export function makeScratch(prefix: string, base: string = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(base, prefix));
}

export function removeScratch(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

export interface FakePackage {
  version: string;
  dependencies?: Record<string, string>;
  /** Folders to create in the package's own node_modules. */
  bundled?: string[];
  extra?: Record<string, unknown>;
}

/** Write a minimal steptix package at `dir`: a package.json and an entry point. */
export function writeFakePackage(dir: string, pkg: FakePackage): string {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'steptix', version: pkg.version, dependencies: pkg.dependencies ?? {}, ...pkg.extra }),
  );
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), `// fake steptix ${pkg.version}\n`);
  for (const name of pkg.bundled ?? []) {
    const depDir = path.join(dir, 'node_modules', name);
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
  return dir;
}

/** A runtime folder as an install leaves it, without going through one. */
export function writeFakeRuntime(layout: Layout, version: string, source = 'npm'): string {
  const dir = writeFakePackage(path.join(layout.runtimesDir, version), { version });
  fs.writeFileSync(path.join(dir, '.steptix-install.json'), JSON.stringify({ version, source }));
  return dir;
}

/** An npm-style install: `<scratch>/npm/node_modules/steptix`. */
export function npmPackageDir(scratch: string): string {
  return path.join(scratch, 'npm', 'node_modules', 'steptix');
}

export function scratchLayout(scratch: string): Layout {
  return layoutOf(path.join(scratch, 'user-root'));
}
