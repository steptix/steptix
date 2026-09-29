import { join as pathJoin } from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveProjectRoot } from './project-root.js';
import { loadConfig } from '../config/loader.js';
import type { Config } from '../config/types.js';
import { resolveEnvBundle, type EnvBundle } from '../env/resolve-bundle.js';
import { logger } from '../utils/logger.js';

/**
 * How a singular action treats a selector that resolves to more than one
 * VISIBLE element — `browser.ambiguousTarget`, normalised so absence and
 * `'first'` are the same value at every read site
 * (stories/codebehind-selector-ambiguity.md).
 */
export type AmbiguousTargetMode = 'first' | 'fail';

/**
 * `browser.ambiguousTarget` as a value with no third state.
 *
 * The config key is optional, so an unconfigured project, a project that wrote
 * `'first'`, and a malformed value all have to mean today's behaviour. Deciding
 * that once, here, is why no caller has to spell `?? 'first'` and get it
 * subtly wrong — the gate is `=== 'fail'`, and everything else is `'first'`.
 */
export function resolveAmbiguousTarget(config: Config): AmbiguousTargetMode {
  return config.browser.ambiguousTarget === 'fail' ? 'fail' : 'first';
}

/**
 * Resolved per-project context for a run: the project's config + the env/data
 * bundle, anchored at the test file's project root (NOT the server's cwd).
 * `projectRoot` is null when no `steptix.config.json` was found above the test
 * file (the defaults fallback). See
 * stories/project-scoped-data-dir-and-env.md.
 */
export interface ProjectBundle {
  projectRoot: string | null;
  config: Config;
  envBundle: EnvBundle | null;
  /**
   * `browser.ambiguousTarget` for THIS project, hoisted out of `config` so it
   * cannot be lost on the way to the runtime that reads it.
   *
   * Hoisted rather than left for callers to read off `config.browser`, because
   * on the server path the `Config` the executor is handed is not this one:
   * `resolveRunSettings` (src/config/run-settings.ts) rebuilds it by spreading
   * the SERVER's startup config and re-sourcing only the handful of values that
   * story owns, so `runConfig.browser.ambiguousTarget` is the server's answer
   * and never the project's. Same shape as `browser.video`, which
   * `resolveSessionOutput` reads off the bundle at session creation for exactly
   * this reason. A per-project key consumed at session-creation time that does
   * not come off the bundle is silently ignored on the server and Steptix
   * paths and works only under the CLI — see the implementation note in
   * stories/codebehind-selector-ambiguity.md.
   *
   * The full list of per-project keys the server threads deliberately, so the
   * next person does not have to rediscover it: `browser.video` (read at
   * session creation by `resolveSessionOutput`), `browser.fixedViewport` (the
   * per-test `## Config: viewport`), `browser.launchArgs` and the whole
   * `desktop` section (both stored on the session by the steps handler from
   * `projectBundle.config`, then read at LAUNCH time and at `[use computer]`
   * respectively). Every other `browser.*` key on the server path is the
   * SERVER's. `desktop` was the measured case: a project with
   * `desktop.enabled: true` was refused because the server's own config —
   * which is what `resolveRunSettings` spreads into `runConfig` — said
   * nothing.
   *
   * Always present: the null-project fallback resolves it from the server's
   * startup config, which carries the `'first'` default.
   */
  ambiguousTarget: AmbiguousTargetMode;
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
   * `steptix.config.json` above the file) falls back to server defaults with no
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
          `Failed to load steptix.config.json for project "${projectRoot}": ${(err as Error).message}`,
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
          'No steptix.config.json found above the test file — using defaults ' +
            '(no project .env/data). ${data.*} references will fail if used.',
        );
      }
    }

    // Resolved from the config this bundle actually loaded — the project's when
    // there is a root, the server's startup config otherwise — so the answer
    // travels with the bundle rather than being re-derived from whichever
    // `Config` a downstream caller happens to hold.
    const bundle: ProjectBundle = {
      projectRoot,
      config,
      envBundle,
      ambiguousTarget: resolveAmbiguousTarget(config),
    };
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
      paths.push(pathJoin(projectRoot, 'steptix.config.json'));
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
