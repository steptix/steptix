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

  it('resolves a $VAR defined only in .env.<name> when that env is selected', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'steptix-cli-param-'));
    try {
      // T2_ONLY exists ONLY in the overlay; SHARED is in both (overlay wins).
      writeFileSync(path.join(root, '.env'), 'SHARED=base\n');
      writeFileSync(path.join(root, '.env.t2'), 'T2_ONLY=from-t2\nSHARED=t2wins\n');

      // Mirrors `--env t2`: the CLI overlays the selected env into process.env.
      await resolveEnvBundle({ envName: 't2', projectRoot: root, mutateProcessEnv: true });

      const resolved = await resolveParameters(
        { token: '$T2_ONLY', shared: '$SHARED' },
        undefined,
        false,
      );

      expect(resolved['token']).toBe('from-t2'); // overlay-only var resolves
      expect(resolved['shared']).toBe('t2wins'); // overlay wins over base
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unset $VAR (in neither base nor overlay) stays unresolved — proves the overlay is what makes it resolve', async () => {
    delete process.env['STEPTIX_T2_ONLY_REGRESSION'];
    const resolved = await resolveParameters(
      { token: '$STEPTIX_T2_ONLY_REGRESSION' },
      undefined,
      false,
    );
    expect(resolved['token']).toBe(''); // unresolvable → empty when promptUser=false
  });
});
