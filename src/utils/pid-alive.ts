/**
 * Is a pid running?
 *
 * `process.kill(pid, 0)` sends no signal and only checks. ESRCH means no such
 * process — the lock is stale. EPERM means the process exists but belongs to
 * another user, which is very much alive. Anything else is unknown, and
 * unknown is treated as alive: refusing a run that could have gone ahead
 * costs a message, while taking over a live holder costs a mouse fight.
 *
 * A module of its own, importing nothing, so the launcher (src/launcher/) can
 * use it without loading the logger. `src/desktop/lock.ts` re-exports it.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}
