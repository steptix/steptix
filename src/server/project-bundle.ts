import { join as pathJoin } from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveProjectRoot } from './project-root.js';
import { loadConfig } from '../config/loader.js';
import type { Config } from '../config/types.js';
import { resolveEnvBundle, type EnvBundle } from '../env/resolve-bundle.js';
import { logger } from '../utils/logger.js';

/**
 * Resolved per-project context for a run: the project's config + the env/data
 * bundle, anchored at the test file's project root (NOT the server's cwd).
 * `projectRoot` is null when no `aiui.config.json` was found above the test
 * file (the defaults fallback). See
 * stories/project-scoped-data-dir-and-env.md.
 */
export interface ProjectBundle {
  projectRoot: string | null;
  config: Config;
  envBundle: EnvBundle | null;
}

/**
 * The project layer of a run, resolved from a test file path and cached per
 * project.
 *
 * Extracted from `SessionManager` so an errand — which has no session and never
 * enters the sessions map — resolves its project exactly as a session does,
 * including sharing the cache. Sharing is the point rather than a saving: two
 * clients running against one project must see the same `.env` at the same
 * moment, and a second cache with its own mtime snapshots is how they stop
 * agreeing.
 */
export class ProjectBundleResolver {
  /**
   * Per-project resolution cache, keyed by `<projectRoot>::<envName>`. Holds the
   * resolved bundle plus the mtimes of every input file (config, `.env`,
   * `.env.<name>`, data JSON) so a saved edit is picked up on the next batch
   * (closes issue 011). Independent of session lifetime — survives Close
   * Session, shared across sessions in the same project.
   */
  private cache = new Map<string, { mtimes: Map<string, number>; bundle: ProjectBundle }>();
  /** Dedupes concurrent (re)loads of the same key so two in-flight batches for
   *  one project don't both read+parse from disk. */
  private inflight = new Map<string, Promise<ProjectBundle>>();

  constructor(private readonly config: Config) {}

  /**
   * Resolve the per-project config + env/data bundle for a step batch from the
   * test file's project root. mtime-cached; returns the cached bundle when no
   * input file changed, otherwise reloads. A null project root (no
   * `aiui.config.json` above the file) falls back to server defaults with no
   * project `.env`/data.
   */
  async resolve(testFilePath: string | undefined, envName: string | null): Promise<ProjectBundle> {
    const projectRoot = testFilePath ? await resolveProjectRoot(testFilePath) : null;
    const key = `${projectRoot ?? '<none>'}::${envName ?? '<none>'}`;

    const cached = this.cache.get(key);
    if (cached && (await this.inputsUnchanged(cached.mtimes))) {
      return cached.bundle;
    }

    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const loadPromise = this.load(projectRoot, envName, key);
    this.inflight.set(key, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async load(
    projectRoot: string | null,
    envName: string | null,
    key: string,
  ): Promise<ProjectBundle> {
    // Per-project config (for tests.dataDir et al.) when we have a root;
    // the server's startup config otherwise. A malformed project config fails
    // only this request — it's never cached, so a fix is picked up next batch.
    let config = this.config;
    if (projectRoot) {
      try {
        config = await loadConfig(undefined, projectRoot);
      } catch (err) {
        throw new Error(
          `Failed to load aiui.config.json for project "${projectRoot}": ${(err as Error).message}`,
        );
      }
    }

    const dataDir = config.tests.dataDir;
    let envBundle: EnvBundle | null = null;
    if (envName) {
      if (projectRoot) {
        envBundle = await resolveEnvBundle({ envName, projectRoot, dataDir, mutateProcessEnv: false });
      } else {
        // Null fallback: no project files to read. Provide the process baseline
        // so ${env.X} (server env) and ${envName} still resolve; data is empty,
        // so ${data.X} fails loudly if used.
        const baseline: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === 'string') baseline[k] = v;
        }
        envBundle = { envName, env: baseline, data: {} };
        logger.warn(
          'No aiui.config.json found above the test file — using defaults ' +
            '(no project .env/data). ${data.*} references will fail if used.',
        );
      }
    }

    const bundle: ProjectBundle = { projectRoot, config, envBundle };
    const mtimes = await this.inputMtimes(projectRoot, envName, dataDir);
    this.cache.set(key, { mtimes, bundle });
    return bundle;
  }

  /** mtimeMs of every bundle input file (config, `.env`, `.env.<name>`, data
   *  JSON); a missing file records 0 so its later appearance invalidates. */
  private async inputMtimes(
    projectRoot: string | null,
    envName: string | null,
    dataDir: string,
  ): Promise<Map<string, number>> {
    const paths: string[] = [];
    if (projectRoot) {
      paths.push(pathJoin(projectRoot, 'aiui.config.json'));
      paths.push(pathJoin(projectRoot, '.env'));
      if (envName) {
        paths.push(pathJoin(projectRoot, `.env.${envName}`));
        paths.push(pathJoin(projectRoot, dataDir, `${envName}.json`));
      }
    }
    const m = new Map<string, number>();
    await Promise.all(
      paths.map(async (p) => {
        try {
          m.set(p, (await stat(p)).mtimeMs);
        } catch {
          m.set(p, 0);
        }
      }),
    );
    return m;
  }

  private async inputsUnchanged(mtimes: Map<string, number>): Promise<boolean> {
    for (const [p, prev] of mtimes) {
      let cur = 0;
      try {
        cur = (await stat(p)).mtimeMs;
      } catch {
        cur = 0;
      }
      if (cur !== prev) return false;
    }
    return true;
  }
}
