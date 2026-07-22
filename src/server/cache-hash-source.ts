/**
 * Decide which step list feeds the `StepCache` bundle hash for a request
 * (issue 016 Bug 2 — skill-aware invalidation). Pure: the caller performs any
 * expansion. See testbench-native/stories/specs/skill-cache-invalidation.md §4.2.
 *
 * The bundle hash must (a) change when a skill body changes, and (b) be
 * identical across every batch of one document — a full run vs a paused/resumed
 * or `[input:]`/`[interactive]`-split *subset* — or the cache never hits across
 * the boundary. So, per request:
 *
 *  - **batch == fullSteps** → `'effective'`: reuse the already-computed
 *    expansion of `steps` (which equals the full document); it already bakes the
 *    skill bodies into the step text.
 *  - **batch ⊊ fullSteps, skills OR sections present** → `'expand-full'`: the
 *    caller must expand the FULL document (not just this batch) so the hash —
 *    including the `seq`-based `__skillN_` namespacing — matches a single-block
 *    full run's.
 *  - **batch ⊊ fullSteps, neither** → `'raw-full'`: hash the raw full document.
 *  - **no fullSteps** (legacy caller) → `'effective'` (matches the prior
 *    `request.fullSteps ?? effectiveSteps` behaviour).
 */
export type CacheHashChoice = 'effective' | 'expand-full' | 'raw-full';

export function chooseCacheHashSource(
  steps: string[],
  fullSteps: string[] | undefined,
  /**
   * Whether this request expands anything at all — skills OR inline sections.
   * Callers pass `!!skillsDir || hasSections(request)`, never a bare
   * truthiness check on the sections map: `{}` is truthy, and treating an
   * empty map as "expands" would move every sectionless subset batch from
   * `raw-full` to `expand-full`.
   */
  hasSkillsOrSections: boolean,
): CacheHashChoice {
  if (!fullSteps || arraysEqual(steps, fullSteps)) return 'effective';
  return hasSkillsOrSections ? 'expand-full' : 'raw-full';
}

/** Element-wise equality for two string arrays. */
export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
