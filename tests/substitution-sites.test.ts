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
 * So this test enumerates CALLS rather than guards. Round seven then escaped
 * the first version of it twice: once with `interpolate`, which the detector
 * did not name, and once by adding a call to a file that was ALREADY
 * classified — the inventory was keyed per file. Both reintroduced a real
 * Set-destroying defect under a fully green suite. Hence the widened name
 * list and the per-file CALL COUNT below.
 *
 * It remains a canary, not a proof. It cannot tell whether a classification
 * is HONEST, only that a new call was considered, and it cannot see an
 * aliased import or a helper under a new name. That is a weaker claim than
 * rounds five and six made, and unlike theirs it is one I have falsified
 * against and it held.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Functions that write a substituted value back into a string.
 *
 * `interpolate` is listed first because omitting it is how round seven broke
 * the first version of this test. It is the repo's primary `{{…}}`
 * substituter, live at eleven call sites, and adding one to a new file left
 * the whole suite green while reintroducing a Set-destroying defect.
 * `\binterpolate\s*\(` does not also match `interpolateEnvData(` — the
 * character after the name there is `E`, not `(` — so each alternative
 * counts once.
 *
 * Evasions this CANNOT see, stated so a reader does not have to discover
 * them: an aliased import (`import { interpolate as bake }`), a new
 * substitution helper under a name not listed here, and dynamic dispatch.
 * This is a canary over the names it knows, not a proof over all of them.
 *
 * `resolveStepText` is the one such helper we know about: the Electron
 * adapter's private wrapper over the first two. Listed so that a new caller
 * of it is counted — the whole point of the count — rather than hidden
 * behind the wrapper's single line (issues/resolved/052 §What the review
 * found).
 */
const SUBSTITUTION_CALL =
  /\b(interpolate|interpolateQuiet|interpolateEnvData|interpolateEnvDataDeep|substituteText|substituteAction|resolveStepText)\s*\(/g;

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

const INVENTORY: Record<string, { why: Classification; calls: number }> = {
  'src/cache/step-cache.ts': { why: 'not-step-text', calls: 2 },
  'src/codebehind/execute.ts': { why: 'not-step-text', calls: 2 },
  'src/codebehind/generate.ts': { why: 'not-step-text', calls: 2 },
  'src/mcp/assemble.ts': { why: 'not-step-text', calls: 1 },
  'src/parser/interpolate-env-data.ts': { why: 'definition', calls: 4 },
  // Several, and deliberately one label: a validate-only main-flow pass, the
  // hook preserve, the guarded skill-body and skill-section passes, and value
  // passes for parameters, rows, config and output names. The count is what
  // makes adding an eighth trip this test.
  'src/parser/markdown.ts': { why: 'step-text/guarded', calls: 8 },
  'src/parser/parameters.ts': { why: 'definition', calls: 1 },
  'src/runner/placeholder-substitution.ts': { why: 'definition', calls: 5 },
  'src/runner/step-executor.ts': { why: 'not-step-text', calls: 2 },
  'src/runner/test-runner.ts': { why: 'step-text/authored', calls: 3 },
  'src/server/errand-runner.ts': { why: 'step-text/authored', calls: 2 },
  'src/server/session-manager.ts': { why: 'step-text/authored', calls: 5 },
  'src/skills/expander.ts': { why: 'step-text/guarded', calls: 4 },
  'src/tools/executor.ts': { why: 'not-step-text', calls: 1 },
  // The Electron loop. Absent from the first version of this table, which is
  // its own small proof that a hand-written inventory needs a mechanical
  // check: it is one of the four loops the feature's whole claim names.
  //
  // Five: the `resolveStepText` definition, the two raw calls on its one
  // line — env/data, then `{{…}}` — and its two callers (issues/resolved/052).
  // The run loop reaches it only after `parseSetStep` has read the authored
  // line, which is what the label certifies. `steer()` reaches it too, for an
  // instruction the user types at a breakpoint — not a test step, and with
  // no `Set` branch at all; a `Set` typed there goes to the model. The label
  // is the stricter of the two rather than a claim about both.
  'src/ui/main/runner-adapter.ts': { why: 'step-text/authored', calls: 5 },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Substitution calls in one file, ignoring comment lines. */
function countCalls(body: string): number {
  let n = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    const found = line.match(SUBSTITUTION_CALL);
    if (found) n += found.length;
  }
  return n;
}

describe('substitution sites are inventoried', () => {
  const root = path.resolve(__dirname, '..');
  const counts = new Map<string, number>();
  for (const full of walk(path.join(root, 'src'))) {
    const n = countCalls(readFileSync(full, 'utf8'));
    if (n > 0) counts.set(path.relative(root, full).split(path.sep).join('/'), n);
  }
  const files = [...counts.keys()].sort();

  it('every file that substitutes is classified', () => {
    expect(
      files.filter((f) => !(f in INVENTORY)),
      'New substitution site(s) found in a file nobody has classified. Decide ' +
        'whether each writes into STEP TEXT — if it does, route it through ' +
        '`substitutePreservingSet` (src/parser/set-step.ts), or a Set step ' +
        'will silently become AI prose there. Then add the file to INVENTORY. ' +
        'Seven review rounds found this defect at a new site each time; this ' +
        'test exists so the eighth does not have to.',
    ).toEqual([]);
  });

  it('every classified file has the call count it was classified with', () => {
    // Per-CALL, not per-file. Round seven escaped the per-file version by
    // adding an unguarded pass to `markdown.ts`, which was already
    // classified — the suite stayed green while a Set step was destroyed.
    const drifted = files
      .filter((f) => f in INVENTORY && counts.get(f) !== INVENTORY[f]!.calls)
      .map((f) => `${f}: ${INVENTORY[f]!.calls} classified, ${counts.get(f)} found`);
    expect(
      drifted,
      'A file that substitutes gained or lost a call since it was classified. ' +
        'If you ADDED one, decide whether it writes into step text (see the ' +
        'classification above it) and update the count. If you removed one, ' +
        'just update the count.',
    ).toEqual([]);
  });

  it('has no stale entries', () => {
    // A classification for a file that no longer substitutes is a reader
    // being told to trust something that is not there.
    expect(Object.keys(INVENTORY).filter((f) => !files.includes(f)).sort()).toEqual([]);
  });
});
