/**
 * Trim a list of selected steps at the first breakpoint encountered.
 *
 * Default behavior: a breakpoint on ANY line in the selection — including
 * the first — stops execution before that line. The arrow lands on the
 * pausedAt line; the runnable list contains everything before it.
 *
 * `options.skipBreakpointAtStart` exempts the first selected line from
 * the breakpoint check. This is what Resume uses: the user explicitly
 * said "continue past this breakpoint", so we run that line and then
 * trim at the NEXT breakpoint.
 *
 * The input is sorted by `id` so callers can pass steps in any order.
 */
export function computeRunnable(selectedSteps, breakpoints, options = {}) {
  if (!Array.isArray(selectedSteps) || selectedSteps.length === 0) {
    return { runnable: [], pausedAt: null };
  }
  const sorted = [...selectedSteps].sort((a, b) => a.id - b.id);
  const skipFirst = !!options.skipBreakpointAtStart;
  const runnable = [];
  let pausedAt = null;

  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];
    const isFirst = i === 0;
    const exempt = isFirst && skipFirst;
    if (!exempt && breakpoints.has(step.id)) {
      pausedAt = step.id;
      break;
    }
    runnable.push(step);
  }

  return { runnable, pausedAt };
}
