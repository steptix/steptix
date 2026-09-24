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
  /\b(interpolate|interpolateQuiet|interpolateEnvData|interpolateEnvDataDeep|substituteText|substituteAsLiterals|substituteAction|resolveStepText)\s*\(/g;

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
  'src/codebehind/execute.ts': { why: 'not-step-text', calls: 2 },
  'src/codebehind/generate.ts': { why: 'not-step-text', calls: 2 },
  'src/mcp/assemble.ts': { why: 'not-step-text', calls: 1 },
  'src/parser/interpolate-env-data.ts': { why: 'definition', calls: 4 },
  // The literal-condition pre-check (src/parser/literal-condition.ts): a
  // CONDITION is substituted so the runtime can decide it without a model
  // call. Not step text by construction — a control line's condition is split
  // off by `parseControlLine` and a flow-control line's by
  // `parseFlowControlStep`, and the TAIL is the step, so nothing here is ever
  // handed to `parseSetStep`. The substituted text is used twice and neither
  // is an instruction: to evaluate, and as the report sentence `decided from
  // the values: "" is empty → true`.
  //
  // `substituteAsLiterals`, not `substituteText`: the grammar reads VALUES,
  // so a reference the author did not already wrap in quotes is substituted
  // as a quoted literal (`{{payment.status}} is "Paused"` →
  // `"Overdue" is "Paused"`). That form is also what the report sentence
  // shows, and it is masked HERE with the run's secrets before it is
  // returned, rather than relying on `redactReport` — neither judge path ever
  // carried a value in its reasoning, so nothing downstream was built
  // expecting one.
  //
  // One module, two callers: `control-runtime.ts` for a guard's condition and
  // `step-executor.ts` for a flow-control line's. Neither substitutes on its
  // own any more.
  'src/runner/literal-decision.ts': { why: 'not-step-text', calls: 1 },
  // Several, and deliberately one label: a validate-only main-flow pass, the
  // hook preserve, the guarded skill-body and skill-section passes, and value
  // passes for parameters, rows, config and output names. The count is what
  // makes adding an eighth trip this test.
  'src/parser/markdown.ts': { why: 'step-text/guarded', calls: 8 },
  'src/parser/parameters.ts': { why: 'definition', calls: 1 },
  // Five: `substituteText`, `substituteAction` and `substituteAsLiterals`
  // themselves, and the calls `substituteAction` and `resolveSetTemplate`
  // make on `substituteText`.
  // `resolveUseAiText` substitutes too, through its own `.replace` over the
  // same grammar — which this detector does not count, so it is named here
  // instead: it builds the MASKED text a `[use ai]` step sends to the model,
  // from a line `parseUseAiStep` has already read, and nothing it returns is
  // ever handed to `parseSetStep` (stories/use-ai-step.md, decision 4).
  'src/runner/placeholder-substitution.ts': { why: 'definition', calls: 5 },
  // The `[use ai]` runner. One call, and it substitutes the `… otherwise …`
  // tail's MESSAGE — the author's warning or error text, resolved for the
  // report — never step text: the step itself was read by `parseUseAiStep`
  // upstream and is filled by `resolveUseAiText` (stories/use-ai-step.md,
  // decision 10).
  'src/runner/use-ai-step-runner.ts': { why: 'not-step-text', calls: 1 },
  'src/runner/step-executor.ts': { why: 'not-step-text', calls: 2 },
  // The computer surface's turn loop (docs/specs/SPEC-use-computer.md §5.5).
  // One call, and it substitutes an ACTION the model emitted — an `api_call`'s
  // url, headers and body — on its way to the same `executeApiCallAction` the
  // page loop uses. Never step text: a `[use …]` line is dispatched by the run
  // loop before this function is reached, the step's own text arrives here
  // already read by `parseSetStep` and `parseFlowControlStep` upstream, and
  // the instruction this loop shows the model is the AUTHORED one with its
  // `{{…}}` intact (§5.7). Nothing here is ever handed back to `parseSetStep`.
  'src/runner/computer-step.ts': { why: 'not-step-text', calls: 1 },
  'src/runner/test-runner.ts': { why: 'step-text/authored', calls: 3 },
  'src/server/errand-runner.ts': { why: 'step-text/authored', calls: 2 },
  'src/server/session-manager.ts': { why: 'step-text/authored', calls: 4 },
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

/**
 * One sentence about spacing inside the braces, in five refusals.
 *
 * Three of them share `NO_SPACES_SENTENCE`
 * (src/runner/placeholder-substitution.ts): the model's action, a `Set`
 * template and the author's own step text. The other two are hand-written and
 * must stay that way — `setStepError` (src/parser/set-step.ts) and
 * `foreachMessage` (src/parser/control-line.ts) are import-free by design, so
 * a parser can answer before a runner module is loaded at all.
 *
 * Hand-written is exactly why this test exists. The sentence has already been
 * reworded once; a reader who meets it twice should not have to decide whether
 * two nearly-identical sentences mean two different things. Only the shared
 * HEAD is compared — each site names its own fix after `write` (`{{name}}`,
 * `Set {{name}} to "…"`, `{{item}}` for the item) and those tails are
 * deliberately different.
 *
 * The SITES are not hand-written, and nor is the count per site. The file
 * above already records what a hand-written list of substitution call sites
 * cost — six rounds of the next site along — and the same two holes are here:
 * a list names only the files someone remembered, and reading one sentence per
 * file cannot see a second copy inside a file already listed. So the list is
 * derived by scanning src/ for the phrase, every occurrence in each file is
 * collected, and the union of all of them must have exactly one member. The
 * three copies above survive as a floor: they must still be there.
 */
describe('the "no spaces inside the braces" sentence', () => {
  const root = path.resolve(__dirname, '..');
  const PHRASE = 'A placeholder carries no spaces';

  /**
   * The copies that must still exist. A floor, not the list compared: the
   * comparison runs over whatever the scan below finds, and this only catches
   * a copy silently DELETED — at which point a reader meets one wording in the
   * runner and none in the parser, and cannot tell whether the refusal moved
   * or the rule did.
   */
  const KNOWN = [
    'src/runner/placeholder-substitution.ts',
    'src/parser/set-step.ts',
    'src/parser/control-line.ts',
  ] as const;

  /**
   * One file as the sentence READS, not as it is typed: comment lines dropped
   * (a docblock that merely mentions the sentence is not a fourth copy of it —
   * `placeholder-substitution.ts` has such a docblock directly above the
   * const), template-literal concatenation seams removed, whitespace
   * collapsed. So a different line wrap is not a difference.
   */
  function flatten(file: string): string {
    return readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//');
      })
      .join('\n')
      .replace(/`\s*\+\s*`/g, '')
      .replace(/\s+/g, ' ');
  }

  /** EVERY reading of the sentence in one file, not just the first.
   *
   *  Reading only the first is how a hand-written list fails twice over: the
   *  list cannot see a copy in a file it does not name, and a first-match read
   *  cannot see a SECOND copy in a file it does. Measured: appending a drifted
   *  copy to `src/parser/set-step.ts` left the previous version of this test
   *  green. */
  function sentencesIn(file: string): string[] {
    return [...flatten(file).matchAll(/A placeholder carries no spaces.*?write /g)].map(
      (m) => m[0],
    );
  }

  // Derived, not hand-written: every `.ts` under src/ that carries the phrase
  // outside a comment. A new refusal that spells the rule again is compared
  // whether or not anyone remembered to add it here.
  const sites = walk(path.join(root, 'src'))
    .map((full) => path.relative(root, full).split(path.sep).join('/'))
    .filter((file) => flatten(file).includes(PHRASE))
    .sort();

  it('reads identically at all three copies, and so at all five refusals', () => {
    // Five refusals, three copies. `placeholder-substitution.ts` holds ONE
    // copy — `NO_SPACES_SENTENCE`, a function — and three refusals call it:
    // the model's action, a `Set` template and the author's own step text.
    // The other two copies are one refusal each, and are hand-written because
    // `setStepError` (src/parser/set-step.ts) and `foreachMessage`
    // (src/parser/control-line.ts) are import-free by design. So text
    // comparison has three things to compare, and five places it protects.
    expect(
      KNOWN.filter((f) => !sites.includes(f)),
      'A file that carried the sentence no longer does. If the refusal moved, ' +
        'move this entry with it; if the rule is gone, delete the entry.',
    ).toEqual([]);

    // Every site yields at least one reading — a file that contains the
    // phrase but no match means the tail stopped ending in `write `, and the
    // comparison below would be quietly comparing fewer things than it names.
    const found = sites.flatMap((file) => sentencesIn(file).map((s) => [file, s] as const));
    expect(
      sites.filter((file) => sentencesIn(file).length === 0),
      'contains the phrase but no readable sentence — has the wording past ' +
        '`write ` changed shape?',
    ).toEqual([]);

    expect(new Set(found.map(([, s]) => s)).size, `differs across:\n${
      found.map(([f, s]) => `  ${f}: ${JSON.stringify(s)}`).join('\n')
    }`).toBe(1);
  });
});
