import chalk from 'chalk';
import { Console } from 'node:console';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConsoleLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Every stdout-bound write in this module goes through `out`, so a single
 * switch can move the lot to stderr.
 *
 * `steptix mcp` speaks JSON-RPC over stdout: one stray log line corrupts the
 * frame and the host drops the connection. `setLogLevel('silent')` is not
 * enough, because `step`/`assertion`/`testStart`/`testEnd` write
 * unconditionally — they predate `shouldEmit` and are the run's headline
 * output, so silencing them by level was never wanted.
 *
 * A private `Console` rather than `stream.write(...)` at each call site:
 * `Console` keeps `%s`/`%d` substitution and `util.inspect` of the rest
 * args, which a hand-rolled write would quietly drop.
 */
let out: Console = globalThis.console;

export function setLogStream(target: 'stdout' | 'stderr'): void {
  out =
    target === 'stderr'
      ? new Console({ stdout: process.stderr, stderr: process.stderr })
      : globalThis.console;
}

/**
 * Severity ordering used to decide whether a message at level `msg` should
 * be emitted given a configured threshold `consoleLevel`. Lower number =
 * less severe. A message is emitted when `RANK[msg] >= RANK[consoleLevel]`.
 */
const RANK: Record<ConsoleLogLevel, number> = {
  silent: 100,
  error: 4,
  warn: 3,
  info: 2,
  debug: 1,
};

let consoleLevel: ConsoleLogLevel = 'info';
const logCallbacks = new Set<(level: LogLevel, message: string) => void>();
const traceCallbacks = new Set<(label: string, payload: unknown) => void>();

export function setLogLevel(level: ConsoleLogLevel): void {
  consoleLevel = level;
}

export function getLogLevel(): ConsoleLogLevel {
  return consoleLevel;
}

/**
 * Should a message at `msgLevel` be emitted given the current configured
 * threshold? Subscribers (e.g. the SSE bridge) call this to mirror console
 * filtering. The per-run file log ignores this and captures everything.
 */
export function shouldEmit(msgLevel: LogLevel): boolean {
  return RANK[msgLevel] >= RANK[consoleLevel];
}

/** Backward-compatible shim — `setVerbose(true)` ⇒ debug, `false` ⇒ info. */
export function setVerbose(enabled: boolean): void {
  consoleLevel = enabled ? 'debug' : 'info';
}

export function isVerbose(): boolean {
  return consoleLevel === 'debug';
}

/**
 * Register a callback that receives every log entry (in addition to console output).
 * Replaces the entire callback set — passing `null` clears all callbacks. Kept for
 * backward compatibility with single-subscriber consumers (e.g. Electron runner-adapter).
 * Concurrent subscribers should use {@link addLogCallback} instead.
 */
export function setLogCallback(fn: ((level: LogLevel, message: string) => void) | null): void {
  logCallbacks.clear();
  if (fn) logCallbacks.add(fn);
}

/**
 * Register an additional log callback. Returns a disposer that removes it.
 * Multiple callbacks are invoked in registration order. A throwing callback is
 * caught and ignored so it cannot break logging for other subscribers.
 */
export function addLogCallback(fn: (level: LogLevel, message: string) => void): () => void {
  logCallbacks.add(fn);
  return () => { logCallbacks.delete(fn); };
}

/**
 * Register a trace-payload callback. Trace entries carry a label and an
 * arbitrary payload (request body, raw response, captured DOM, etc.) — too
 * large to put on the regular log stream (would flood the Steptix output
 * panel) but valuable for post-mortem analysis when written to disk.
 *
 * Trace callbacks fire ONLY for `logger.trace(...)` calls and are independent
 * of the regular log callbacks. Returns a disposer.
 */
export function addTraceCallback(fn: (label: string, payload: unknown) => void): () => void {
  traceCallbacks.add(fn);
  return () => { traceCallbacks.delete(fn); };
}

function notify(level: LogLevel, message: string): void {
  for (const cb of logCallbacks) {
    try { cb(level, message); } catch { /* never let a listener break logging */ }
  }
}

function notifyTrace(label: string, payload: unknown): void {
  for (const cb of traceCallbacks) {
    try { cb(label, payload); } catch { /* never let a listener break logging */ }
  }
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldEmit('debug')) {
      out.log(chalk.gray(`[${timestamp()}] [DEBUG] ${message}`), ...args);
    }
    notify('debug', message);
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldEmit('info')) {
      out.log(chalk.cyan(`[${timestamp()}] [INFO]  ${message}`), ...args);
    }
    notify('info', message);
  },

  success(message: string, ...args: unknown[]): void {
    if (shouldEmit('info')) {
      out.log(chalk.green(`[${timestamp()}] [PASS]  ${message}`), ...args);
    }
    notify('info', message);
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldEmit('warn')) {
      console.warn(chalk.yellow(`[${timestamp()}] [WARN]  ${message}`), ...args);
    }
    notify('warn', message);
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldEmit('error')) {
      console.error(chalk.red(`[${timestamp()}] [ERROR] ${message}`), ...args);
    }
    notify('error', message);
  },

  step(index: number, total: number, instruction: string): void {
    out.log(
      chalk.bold.blue(`\n[${timestamp()}] Step ${index}/${total}:`),
      chalk.white(instruction),
    );
  },

  subAction(description: string): void {
    if (shouldEmit('info')) {
      out.log(chalk.dim(`  → ${description}`));
    }
    notify('info', `→ ${description}`);
  },

  assertion(pass: boolean, actual: string, expected: string): void {
    const icon = pass ? chalk.green('✓') : chalk.red('✗');
    const label = pass ? chalk.green('PASS') : chalk.red('FAIL');
    out.log(`  ${icon} Assertion [${label}]`);
    out.log(chalk.dim(`    Expected: ${expected}`));
    out.log(chalk.dim(`    Actual:   ${actual}`));
  },

  testStart(name: string): void {
    out.log(chalk.bold(`\n${'─'.repeat(60)}`));
    out.log(chalk.bold.white(`  TEST: ${name}`));
    out.log(chalk.bold(`${'─'.repeat(60)}\n`));
  },

  testEnd(name: string, passed: boolean, durationMs: number): void {
    const status = passed ? chalk.green.bold('PASSED') : chalk.red.bold('FAILED');
    const duration = chalk.dim(`(${(durationMs / 1000).toFixed(1)}s)`);
    out.log(chalk.bold(`\n${'─'.repeat(60)}`));
    out.log(`  ${name}: ${status} ${duration}`);
    out.log(chalk.bold(`${'─'.repeat(60)}\n`));
  },

  /**
   * Emit a structured trace entry — label + arbitrary payload. Goes ONLY to
   * subscribers registered via `addTraceCallback` (typically the per-run log
   * file). Never writes to the console or to regular log callbacks, so it's
   * safe to dump large payloads (full prompts, raw responses) without flooding
   * the Steptix output panel.
   */
  trace(label: string, payload: unknown): void {
    notifyTrace(label, payload);
  },

  tokenWarning(used: number, budget: number): void {
    const pct = Math.round((used / budget) * 100);
    console.warn(
      chalk.yellow(
        `[${timestamp()}] [WARN]  Token budget: ${used.toLocaleString()} / ${budget.toLocaleString()} (${pct}%)`,
      ),
    );
  },
};

/**
 * Wrap an async operation with begin / end / failure logging.
 *
 * Purpose: when a step hangs, the most recent log line tells you exactly
 * which operation is in flight. Without this, the only log appears AFTER
 * the call returns, so a silent hang produces no diagnostic.
 *
 * Behavior:
 *   - Emits `▶ BEGIN: <name>` at debug before invoking `fn`.
 *   - On success: `✔ END: <name> (Xms)` at debug.
 *   - On throw: `✗ FAIL: <name> (Xms): <error>` at error, then rethrows the original error.
 */
export async function traceOp<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  logger.debug(`▶ BEGIN: ${name}`);
  try {
    const result = await fn();
    const ms = Date.now() - start;
    logger.debug(`✔ END: ${name} (${ms}ms)`);
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`✗ FAIL: ${name} (${ms}ms): ${message}`);
    throw err;
  }
}
