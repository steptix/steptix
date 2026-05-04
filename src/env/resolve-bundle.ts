import { loadEnvFile } from './loader.js';
import { loadDataFile, type DataObject } from './data-loader.js';

export interface EnvBundle {
  /** The env name that was selected (after precedence resolution). */
  envName: string | null;
  /** The full process.env snapshot after `.env.<name>` was merged. */
  env: Record<string, string>;
  /** Parsed `data/<name>.json` (may be empty if the file doesn't exist). */
  data: DataObject;
}

export interface ResolveBundleOptions {
  /** The env name to load. When undefined/empty, no .env or data file is loaded. */
  envName?: string | undefined;
  /** Project root used to resolve `.env.<name>` and `data/<name>.json`. */
  projectRoot?: string;
}

/**
 * One-shot env+data loader used by every entry point (CLI, programmatic, tests).
 * Loads `.env.<envName>` into process.env via the existing loader, then loads
 * `data/<envName>.json` (resolving `$VAR` leaves), and returns both.
 *
 * Why this lives on its own: the CLI used to load just the .env file. The new
 * dropdown / programmatic / CI paths all need the same combined behaviour, so
 * funneling them through a single function avoids drift between surfaces.
 */
export async function resolveEnvBundle(opts: ResolveBundleOptions = {}): Promise<EnvBundle> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const envName = opts.envName?.trim() || null;

  if (envName) {
    await loadEnvFile(envName, projectRoot);
  }

  const data = envName
    ? await loadDataFile(envName, projectRoot)
    : {};

  // Snapshot process.env as plain Record<string, string> — process.env's
  // stringy-but-typed-as-undefined-able shape is awkward to thread through
  // tests; freezing a snapshot here keeps interpolation deterministic for the
  // life of the run.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }

  return { envName, env, data };
}
