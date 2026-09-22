/**
 * The one-computer-mode-session-per-machine lock
 * (docs/specs/SPEC-use-computer.md §5.9).
 *
 * Two computer-mode sessions would fight over one mouse, and neither would
 * fail in a way that named the cause — the symptom is a click landing
 * somewhere plausible but wrong, minutes from the step that caused it. So the
 * second one is refused, by name, before it moves anything.
 *
 * A FILE rather than an in-process flag, because the sessions that collide are
 * usually not in one process: a TestBench window and a CLI run, or two servers
 * on two ports from two worktrees. The same reason makes a stale file the
 * normal failure: a killed server never releases, so a lock whose pid is dead
 * is taken over with a WARN rather than becoming a machine that can no longer
 * run computer tests until someone deletes a file in the temp directory.
 *
 * Note what "the same holder" means: the same PID *and* the same session. One
 * server process runs many sessions, and the second of them wanting the mouse
 * is exactly the collision §5.9 describes, even though it shares a pid with
 * the holder.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface ComputerLockRecord {
  pid: number;
  sessionId: string;
  /** ISO 8601, for the message and for a human reading the file. */
  since: string;
}

export interface ComputerLockOptions {
  /** Overridden by tests so they never touch the real machine lock. */
  lockPath?: string;
  /** This process's pid. Overridden by tests to play both holders. */
  pid?: number;
  /** Liveness test. Defaults to {@link isPidAlive}. */
  isAlive?: (pid: number) => boolean;
}

/** §5.9 — `os.tmpdir()/aiui-computer.lock`. */
export function computerLockPath(): string {
  return path.join(os.tmpdir(), 'aiui-computer.lock');
}

/**
 * Is a pid running?
 *
 * `process.kill(pid, 0)` sends no signal and only checks. ESRCH means no such
 * process — the lock is stale. EPERM means the process exists but belongs to
 * another user, which is very much alive. Anything else is unknown, and
 * unknown is treated as alive: refusing a run that could have gone ahead
 * costs a message, while taking over a live holder costs a mouse fight.
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

/** §5.9's refusal, in the spec's own words. */
export function computerLockInUseMessage(record: ComputerLockRecord): string {
  return `computer mode is in use by session ${record.sessionId} (pid ${record.pid}) — one computer-mode run per machine`;
}

function resolve(options: ComputerLockOptions): { file: string; pid: number; isAlive: (pid: number) => boolean } {
  return {
    file: options.lockPath ?? computerLockPath(),
    pid: options.pid ?? process.pid,
    isAlive: options.isAlive ?? isPidAlive,
  };
}

/** The lock's current holder, or null when it is free (or unreadable). */
export function readComputerLock(options: ComputerLockOptions = {}): ComputerLockRecord | null {
  const { file } = resolve(options);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ComputerLockRecord).pid === 'number' &&
      typeof (parsed as ComputerLockRecord).sessionId === 'string'
    ) {
      const record = parsed as ComputerLockRecord;
      return { pid: record.pid, sessionId: record.sessionId, since: record.since ?? '' };
    }
  } catch {
    // Truncated by a kill mid-write, or edited by hand. Falls through to
    // "free", and the WARN is emitted by the caller that takes it over.
  }
  return null;
}

function write(file: string, record: ComputerLockRecord): void {
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Take the lock for `sessionId`, or throw §5.9's message.
 *
 * Idempotent for the same pid AND session: re-entering computer mode in a
 * session that already holds it keeps the original `since`, so the record
 * still says when the mouse was first taken.
 */
export function acquireComputerLock(
  sessionId: string,
  options: ComputerLockOptions = {},
): ComputerLockRecord {
  const { file, pid, isAlive } = resolve(options);
  const record: ComputerLockRecord = { pid, sessionId, since: new Date().toISOString() };

  // Atomic in the common case: `wx` creates or fails, so two processes racing
  // for a free lock cannot both believe they read "free" and then both write.
  try {
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return record;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const held = readComputerLock(options);
  if (held === null) {
    // Present but unreadable — a truncated write from a killed process.
    logger.warn(`[computer] replacing an unreadable lock file at ${file}`);
    write(file, record);
    return record;
  }

  if (held.pid === pid && held.sessionId === sessionId) {
    return held;
  }

  if (isAlive(held.pid)) {
    throw new Error(computerLockInUseMessage(held));
  }

  logger.warn(
    `[computer] taking over a stale lock from session ${held.sessionId} (pid ${held.pid} is gone)`,
  );
  write(file, record);
  return record;
}

/**
 * Release the lock if this pid+session holds it. Returns whether it did.
 *
 * Deliberately refuses to delete someone else's record: `[use browser]` and
 * session close both call this, and a session that never took the lock —
 * because another one held it and the step failed — must not release the
 * holder's on its way out.
 */
export function releaseComputerLock(
  sessionId: string,
  options: ComputerLockOptions = {},
): boolean {
  const { file, pid } = resolve(options);
  const held = readComputerLock(options);
  if (held === null) {
    // Nothing, or something unreadable. Unreadable is still ours to clear
    // only if nobody else can claim it; leaving it costs the next run a WARN
    // and nothing more, so leave it.
    return false;
  }
  if (held.pid !== pid || held.sessionId !== sessionId) {
    logger.debug(
      `[computer] not releasing the lock: it is held by session ${held.sessionId} (pid ${held.pid})`,
    );
    return false;
  }
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return true;
}
