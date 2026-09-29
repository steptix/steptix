import { readDefaultEnvVars, readEnvFileVars } from './loader.js';
import { loadDataFile, type DataObject } from './data-loader.js';

export interface EnvBundle {
  /** The env name that was selected (after precedence resolution). */
  envName: string | null;
  /** The composed env map: process baseline + project base `.env` + project
   *  `.env.<name>`. On the server this is per-project and `process.env` is
   *  left untouched; on the CLI it mirrors `process.env`. */
  env: Record<string, string>;
  /** Parsed `<dataDir>/<name>.json` (may be empty if the file doesn't exist). */
  data: DataObject;
}

export interface ResolveBundleOptions {
  /** The env name to load. When undefined/empty, no .env or data file is loaded. */
  envName?: string | undefined;
  /** Project root used to resolve `.env`, `.env.<name>`, and `<dataDir>/<name>.json`. */
  projectRoot?: string;
  /** Data directory (from `tests.dataDir`), resolved relative to `projectRoot`.
   *  Default `data`. */
  dataDir?: string;
  /**
   * When true, also merge the project's `.env` / `.env.<name>` into the real
   * `process.env` (the CLI single-project path, so consumers that read
   * `process.env` directly — API auth, param `$VAR` — still see project
   * values). When false (the shared server), the bundle is composed into an
   * isolated per-project map and `process.env` is never touched, so concurrent
   * runs for different projects can't contaminate each other. Default false.
   */
  mutateProcessEnv?: boolean;
}

/**
 * One-shot env+data loader used by every entry point (CLI, programmatic, server,
 * tests). Composes the env map with precedence — process baseline (lowest),
 * project base `.env`, then `.env.<name>` (highest) — and loads
 * `<dataDir>/<name>.json` (resolving `$VAR` leaves against the composed map).
 *
 * See stories/project-scoped-data-dir-and-env.md for why the server path must
 * NOT mutate the global `process.env`.
 */
export async function resolveEnvBundle(opts: ResolveBundleOptions = {}): Promise<EnvBundle> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const envName = opts.envName?.trim() || null;
  const dataDir = opts.dataDir ?? 'data';

  // Baseline = the process's own environment (OS env, the server/CLI startup
  // base `.env`, STEPTIX_SERVER_API_KEY, etc). Project layers compose ON TOP of this.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }

  if (envName) {
    const baseDotenv = await readDefaultEnvVars(projectRoot);
    const envDotenv = await readEnvFileVars(envName, projectRoot);

    // Base `.env` fills only keys not already in the baseline (shell/startup
    // wins — matches loadDefaultEnvFileSync); `.env.<name>` overrides (most
    // specific — matches loadEnvFile).
    for (const [k, v] of Object.entries(baseDotenv)) {
      if (!(k in env)) env[k] = v;
    }
    Object.assign(env, envDotenv);

    if (opts.mutateProcessEnv) {
      for (const [k, v] of Object.entries(baseDotenv)) {
        if (!(k in process.env)) process.env[k] = v;
      }
      Object.assign(process.env, envDotenv);
    }
  }

  const data = envName
    ? await loadDataFile(envName, projectRoot, dataDir, env)
    : {};

  return { envName, env, data };
}
