/**
 * How a saved `.testbench/run-state.json` status list becomes the gutter's
 * statuses again on load — pure, no VS Code dependency, so the fast
 * `node --test` suite can pin it.
 *
 * Status strings are otherwise taken as written rather than checked against
 * `LineStatus` (see `ActiveFileTracker.hydrate`), which is what keeps the
 * union safe to widen. Narrowing it is the other direction, and needs this:
 * a file written by an older build can still carry a status this one no
 * longer has.
 */

/**
 * Statuses an older build wrote that this one no longer paints, and what each
 * reads as now.
 *
 * `pass-cached` was the ⚡ mark for a step the step cache replayed. The cache
 * is gone, and the step it marked did pass — so it restores as a plain ✓
 * rather than as a mark the decorations have no icon for, which would leave
 * the line blank and lose a pass the run really had.
 */
const RETIRED_STATUSES: Readonly<Record<string, string>> = {
  'pass-cached': 'pass',
};

/**
 * The persisted `[line, status]` pairs to restore: `running` dropped (no run
 * is in flight after a reload) and every retired status mapped to its
 * replacement. Anything else passes through unchanged.
 */
export function restoredStatuses<S extends string>(
  persisted: ReadonlyArray<readonly [number, S]>,
): Array<[number, S]> {
  const out: Array<[number, S]> = [];
  for (const [line, status] of persisted) {
    if (status === 'running') continue;
    // Own keys only: a plain lookup would answer a status spelled like an
    // `Object.prototype` member (`constructor`, `toString`) with a function.
    const replacement = Object.hasOwn(RETIRED_STATUSES, status) ? RETIRED_STATUSES[status] : undefined;
    out.push([line, (replacement ?? status) as S]);
  }
  return out;
}
