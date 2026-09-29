import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached: string | undefined;

/**
 * This package's version, read once per process from `package.json`.
 *
 * One implementation on purpose: `steptix --version` and `GET /health`'s
 * `version` must agree, since the whole point of reporting it is telling the
 * user *which build* is answering. Two copies of the same `../../package.json`
 * relative walk would drift the moment the dist layout changes — and drift
 * silently, each falling back to its own placeholder.
 */
export function getPackageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf-8')) as {
      version?: string;
    };
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
