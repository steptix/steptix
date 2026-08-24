import { resolve as pathResolve } from 'node:path';

/**
 * One compile per test file at a time, whichever route asked.
 *
 * `POST /codebehind/compile` has held this rule since
 * stories/codebehind-compile.md; stories/compile-as-you-go.md adds two more
 * ways to compile the same file — a Run & Compile and a Compile This Step,
 * both of which arrive on `POST /sessions/:id/steps` — so the set has to be
 * shared rather than owned by the compile route. Two compiles of one file
 * would each propose a whole `.steps.ts` for it, and the second Apply would
 * silently discard the first's entries.
 *
 * A module-level instance, deliberately: the lock is a property of the
 * server process, and threading one through every constructor would only
 * invite a second one being created by mistake.
 */

/**
 * The lock key for a test file.
 *
 * `path.resolve` alone is not enough on Windows, where it preserves the
 * drive-letter case it was handed: TestBench's paths come from `uri.fsPath`,
 * which lower-cases the drive, while a CLI or MCP caller's usually does not.
 * Two spellings of one file would then take two locks and compile the same
 * test twice, concurrently, each proposing a whole `.steps.ts` for it.
 */
export function compileLockKey(testFilePath: string): string {
  const resolved = pathResolve(testFilePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export class CompileLock {
  private readonly inFlight = new Set<string>();

  /**
   * Is a compile of this file running?
   *
   * Read by a route before it opens its stream — a 409 has to be a status
   * code, and once the headers are flushed the answer is a 200 whatever
   * happens. Callers still `acquire` afterwards for the same reason
   * `executeSteps` queues: two callers can both read false.
   */
  isLocked(testFilePath: string): boolean {
    return this.inFlight.has(compileLockKey(testFilePath));
  }

  /** Take the lock, or return null when someone else holds it. The returned
   *  function releases it and is safe to call more than once. */
  acquire(testFilePath: string): (() => void) | null {
    const key = compileLockKey(testFilePath);
    if (this.inFlight.has(key)) return null;
    this.inFlight.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.delete(key);
    };
  }
}

/** The process's lock. Every compile path shares it. */
export const compileLock = new CompileLock();
