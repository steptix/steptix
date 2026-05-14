/**
 * Helpers for cleaning up the per-line gutter status map when a run ends
 * unexpectedly (Stop, abort, error). The active line stays "running" until
 * we explicitly demote it; otherwise the gutter keeps blinking forever.
 */

const RUNNING = 'running';

/**
 * Drop every RUNNING entry, keeping pass / fail / skip / anything else.
 * Returns a new object — never mutates the input.
 */
export function clearRunningStatuses(statuses) {
  const out = {};
  for (const [k, v] of Object.entries(statuses)) {
    if (v !== RUNNING) out[k] = v;
  }
  return out;
}
