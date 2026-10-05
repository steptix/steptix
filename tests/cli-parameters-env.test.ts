/**
 * Regression: the CLI's `## Parameters` `$VAR` references must resolve against
 * the selected env file (`--env <name>` / `AUTOMATION_ENV` / frontmatter), not
 * just the base `.env`.
 *
 * The CLI already does this — `resolveEnvBundle({ mutateProcessEnv: true })`
 * overlays base `.env` + `.env.<name>` into the real `process.env`, and
 * `resolveParameters` reads `process.env` directly. This test pins that chain
 * so it can't silently regress (the Steptix extension had the equivalent gap;
 * see issues/034).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveEnvBundle } from '../src/env/resolve-bundle.js';
import { resolveParameters } from '../src/parser/parameters.js';

describe('CLI: ## Parameters honour the selected env file', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  /** One project, two named envs. T2_ONLY exists ONLY in the t2 overlay; SHARED is
   *  in the base and in t2 (overlay wins); t3 is the env that knows neither.
   *  Both keys are cleared from the process first, so the base `.env` is what
   *  supplies SHARED — it only fills keys the process does not already have. */
  function makeProject(): string {
    delete process.env['T2_ONLY'];
    delete process.env['SHARED'];
    const root = mkdtempSync(path.join(tmpdir(), 'steptix-cli-param-'));
    writeFileSync(path.join(root, '.env'), 'SHARED=base\n');
    writeFileSync(path.join(root, '.env.t2'), 'T2_ONLY=from-t2\nSHARED=t2wins\n');
    writeFileSync(path.join(root, '.env.t3'), 'T3_ONLY=from-t3\n');
    return root;
  }

  const params = { token: '$T2_ONLY', shared: '$SHARED' };

  it('resolves a $VAR defined only in .env.<name> when that env is selected', async () => {
    const root = makeProject();
    try {
      // Mirrors `--env t2`: the CLI overlays the selected env into process.env.
      await resolveEnvBundle({ envName: 't2', projectRoot: root, mutateProcessEnv: true });

      const resolved = await resolveParameters(params, undefined, false);

      expect(resolved['token']).toBe('from-t2'); // overlay-only var resolves
      expect(resolved['shared']).toBe('t2wins'); // overlay wins over base
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('the same project with another env selected leaves it unresolved — the overlay is what makes it resolve', async () => {
    // The control for the test above: same files, same parameters, only the
    // selection differs. If something other than the t2 overlay resolved
    // $T2_ONLY (every .env.* file read, say), the token would come back
    // 'from-t2' here too.
    const root = makeProject();
    try {
      await resolveEnvBundle({ envName: 't3', projectRoot: root, mutateProcessEnv: true });

      const resolved = await resolveParameters(params, undefined, false);

      expect(resolved['token']).toBe(''); // unresolvable → empty when promptUser=false
      expect(resolved['shared']).toBe('base'); // the base .env still applies
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
