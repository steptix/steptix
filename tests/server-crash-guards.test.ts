/**
 * issues/047 — the Sessions API's last line of defence.
 *
 * `installDialogGuard` fixes the known killer at source. This is the backstop
 * for the next one: a stray rejection inside some browser event listener says
 * nothing about whether this process can keep serving the sessions it holds,
 * and Node's default — exit — is calibrated for a one-shot script, not for a
 * shared server whose death loses every client's session and orphans every
 * browser it launched.
 */
import { describe, it, expect } from 'vitest';
import { installCrashGuards, type CrashGuardTarget } from '../src/server/api-server.js';
import { addLogCallback, type LogLevel } from '../src/utils/logger.js';

/** A stand-in for `process` — the real one must not come out of a unit test
 *  with handlers still attached. */
function fakeProcess(): {
  target: CrashGuardTarget;
  fire: (event: 'unhandledRejection' | 'uncaughtException', reason: unknown) => void;
  registered: () => string[];
} {
  const handlers = new Map<string, (reason: unknown) => void>();
  const target: CrashGuardTarget = {
    on(event: string, listener: (reason: unknown) => void) {
      handlers.set(event, listener);
      return target;
    },
  };
  return {
    target,
    fire: (event, reason) => handlers.get(event)?.(reason),
    registered: () => [...handlers.keys()],
  };
}

function withLogs<T>(work: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const stop = addLogCallback((level: LogLevel, message: string) => {
    lines.push(`${level}: ${message}`);
  });
  try {
    return { result: work(), lines };
  } finally {
    stop();
  }
}

describe('installCrashGuards', () => {
  it('registers both guards', () => {
    const proc = fakeProcess();
    installCrashGuards(proc.target);
    expect(proc.registered()).toEqual(
      expect.arrayContaining(['unhandledRejection', 'uncaughtException']),
    );
  });

  it('logs an unhandled rejection with its stack and does not rethrow', () => {
    const proc = fakeProcess();
    installCrashGuards(proc.target);
    const err = new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');

    const { lines } = withLogs(() => {
      // The contract in one line: firing must not throw, because throwing from
      // an uncaughtException handler is the one way to make things worse.
      expect(() => proc.fire('unhandledRejection', err)).not.toThrow();
    });

    const line = lines.find((l) => l.includes('Unhandled promise rejection'));
    expect(line).toBeDefined();
    expect(line).toContain('error:');
    // The stack is the reason you want one of these at all — a bare message
    // would not have located this bug inside playwright-core.
    expect(line).toContain('handleJavaScriptDialog');
    expect(line).toContain('at ');
  });

  it('logs an uncaught exception and does not rethrow', () => {
    const proc = fakeProcess();
    installCrashGuards(proc.target);

    const { lines } = withLogs(() => {
      expect(() => proc.fire('uncaughtException', new Error('boom'))).not.toThrow();
    });

    expect(lines.some((l) => l.includes('Uncaught exception') && l.includes('boom'))).toBe(true);
  });

  it('survives a non-Error rejection value', () => {
    // `Promise.reject('string')` and `reject(undefined)` both reach here, and a
    // guard that throws on its own input defeats the point of the guard.
    const proc = fakeProcess();
    installCrashGuards(proc.target);

    const { lines } = withLogs(() => {
      expect(() => proc.fire('unhandledRejection', 'just a string')).not.toThrow();
      expect(() => proc.fire('unhandledRejection', undefined)).not.toThrow();
    });

    expect(lines.some((l) => l.includes('just a string'))).toBe(true);
    expect(lines.some((l) => l.includes('undefined'))).toBe(true);
  });
});
