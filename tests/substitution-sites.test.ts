/**
 * The closure argument for `Set {{name}} to "…"`, made mechanical.
 *
 * Six review rounds each found the same defect at the NEXT substitution site
 * along — row bindings, skill arguments, hook baking, skill bodies — because
 * each round fixed the instance and then asserted closure in prose. Round
 * five replaced the prose with `substitutePreservingSet` and a parameterised
 * test over the four known sites. Round six disproved even that: it added a
 * fifteen-line substitution site in `src/runner/hooks.ts`, reintroduced the
 * exact defect, and watched all 3725 tests stay green. A hand-written list
 * pins what it names and cannot see what it does not.
 *
 * So this test does not enumerate GUARDS, it enumerates CALLS. Every call to
 * a substitution function in `src/` is inventoried below with a
 * classification. Add a new one and this test fails until you classify it —
 * which is the point at which someone has to decide whether it writes into
 * step text, and therefore whether it needs `substitutePreservingSet`.
 *
 * It is a canary, not a proof: it cannot tell that a classification is
 * HONEST, only that a new call was considered. That is a weaker claim than
 * round five made, and it is the true one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Functions that write a substituted value back into a string. */
const SUBSTITUTION_CALL = /\b(interpolateEnvData|interpolateQuiet|substituteText)\s*\(/;

/**
 * Why each call site is safe. The classification is the load-bearing part —
 * a reader auditing this feature reads this table, not the code.
 *
 *  - `step-text/guarded`   writes into STEP TEXT and goes through
 *                          `substitutePreservingSet`.
 *  - `step-text/preserved` writes into step text but SKIPS a Set step, leaving
 *                          the token for `resolveSetTemplate` to resolve.
 *  - `step-text/authored`  the runtime's own per-step resolution, which reads
 *                          the authored line first and never re-parses after.
 *  - `not-step-text`       substitutes a VALUE (a parameter, a row cell, a
 *                          config entry, an output NAME) that no one ever
 *                          hands to `parseSetStep`.
 *  - `definition`          the substitution function itself.
 */
type Classification =
  | 'step-text/guarded'
  | 'step-text/preserved'
  | 'step-text/authored'
  | 'not-step-text'
  | 'definition';

const INVENTORY: Record<string, Classification> = {
  'src/codebehind/execute.ts': 'not-step-text',
  'src/codebehind/generate.ts': 'not-step-text',
  'src/mcp/assemble.ts': 'not-step-text',
  // markdown.ts holds several: the validate-only main-flow pass, the hook
  // preserve, the guarded skill-body pass, and value passes for parameters,
  // rows, config and output names.
  'src/parser/markdown.ts': 'step-text/guarded',
  'src/parser/interpolate-env-data.ts': 'definition',
  'src/runner/placeholder-substitution.ts': 'definition',
  'src/runner/step-executor.ts': 'not-step-text',
  'src/runner/test-runner.ts': 'step-text/authored',
  'src/server/errand-runner.ts': 'step-text/authored',
  'src/server/session-manager.ts': 'step-text/authored',
  'src/skills/expander.ts': 'step-text/guarded',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('substitution sites are inventoried', () => {
  const root = path.resolve(__dirname, '..');
  const files = walk(path.join(root, 'src'))
    .filter((f) => {
      const body = readFileSync(f, 'utf8');
      return body
        .split('\n')
        .some((line) => SUBSTITUTION_CALL.test(line) && !line.trimStart().startsWith('*'));
    })
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort();

  it('every file that substitutes is classified', () => {
    const unclassified = files.filter((f) => !(f in INVENTORY));
    expect(
      unclassified,
      `New substitution site(s) found. Decide whether each writes into STEP ` +
        `TEXT — if it does, route it through \`substitutePreservingSet\` ` +
        `(src/parser/set-step.ts), or a Set step will silently become AI ` +
        `prose there. Then add the file to INVENTORY. Six review rounds each ` +
        `found this defect at a new site; this test exists so the seventh ` +
        `does not have to.`,
    ).toEqual([]);
  });

  it('has no stale entries', () => {
    // A classification for a file that no longer substitutes is a reader
    // being told to trust something that is not there.
    expect(Object.keys(INVENTORY).filter((f) => !files.includes(f)).sort()).toEqual([]);
  });
});
