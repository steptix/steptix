import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let verboseMode = false;
let logCallback: ((level: LogLevel, message: string) => void) | null = null;

export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
}

/** Register a callback that receives every log entry (in addition to console output). */
export function setLogCallback(fn: ((level: LogLevel, message: string) => void) | null): void {
  logCallback = fn;
}

function notify(level: LogLevel, message: string): void {
  logCallback?.(level, message);
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (!verboseMode) return;
    console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${message}`), ...args);
    notify('debug', message);
  },

  info(message: string, ...args: unknown[]): void {
    console.log(chalk.cyan(`[${timestamp()}] [INFO]  ${message}`), ...args);
    notify('info', message);
  },

  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green(`[${timestamp()}] [PASS]  ${message}`), ...args);
    notify('info', message);
  },

  warn(message: string, ...args: unknown[]): void {
    console.warn(chalk.yellow(`[${timestamp()}] [WARN]  ${message}`), ...args);
    notify('warn', message);
  },

  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red(`[${timestamp()}] [ERROR] ${message}`), ...args);
    notify('error', message);
  },

  step(index: number, total: number, instruction: string): void {
    console.log(
      chalk.bold.blue(`\n[${timestamp()}] Step ${index}/${total}:`),
      chalk.white(instruction),
    );
  },

  subAction(description: string): void {
    console.log(chalk.dim(`  → ${description}`));
  },

  assertion(pass: boolean, actual: string, expected: string): void {
    const icon = pass ? chalk.green('✓') : chalk.red('✗');
    const label = pass ? chalk.green('PASS') : chalk.red('FAIL');
    console.log(`  ${icon} Assertion [${label}]`);
    console.log(chalk.dim(`    Expected: ${expected}`));
    console.log(chalk.dim(`    Actual:   ${actual}`));
  },

  testStart(name: string): void {
    console.log(chalk.bold(`\n${'─'.repeat(60)}`));
    console.log(chalk.bold.white(`  TEST: ${name}`));
    console.log(chalk.bold(`${'─'.repeat(60)}\n`));
  },

  testEnd(name: string, passed: boolean, durationMs: number): void {
    const status = passed ? chalk.green.bold('PASSED') : chalk.red.bold('FAILED');
    const duration = chalk.dim(`(${(durationMs / 1000).toFixed(1)}s)`);
    console.log(chalk.bold(`\n${'─'.repeat(60)}`));
    console.log(`  ${name}: ${status} ${duration}`);
    console.log(chalk.bold(`${'─'.repeat(60)}\n`));
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
