/**
 * `steptix run`'s backstop: a run that never finished cannot exit 0 (#46).
 *
 * Node exits 0 when its event loop runs dry, and `beforeExit` is the one
 * moment the CLI hears about it. The guard is exercised against a stand-in
 * process — an EventEmitter with an `exitCode` — so nothing here emits
 * `beforeExit` on, or changes the exit code of, the process running the
 * tests. The real `process` is used once, only to show that disarming leaves
 * no listener behind.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { guardUnfinishedRun, UNFINISHED_RUN_MESSAGE } from '../src/cli/commands/run.js';

function fakeProcess(exitCode?: number) {
  return Object.assign(new EventEmitter(), {
    exitCode: exitCode as number | string | null | undefined,
  });
}

describe('guardUnfinishedRun', () => {
  it('turns an exit with the run still pending into exit code 1, and says why', () => {
    const proc = fakeProcess();
    const logged: string[] = [];
    guardUnfinishedRun(proc, (message) => logged.push(message));

    proc.emit('beforeExit', 0);

    expect(proc.exitCode).toBe(1);
    expect(logged).toEqual([UNFINISHED_RUN_MESSAGE]);
  });

  // Logging can wake the loop (an asynchronous stderr write), and the loop
  // running dry again must then exit rather than log again, forever.
  it('fires once', () => {
    const proc = fakeProcess();
    const logged: string[] = [];
    guardUnfinishedRun(proc, (message) => logged.push(message));

    proc.emit('beforeExit', 0);
    proc.emit('beforeExit', 1);

    expect(logged).toHaveLength(1);
    expect(proc.listenerCount('beforeExit')).toBe(0);
  });

  it('keeps an exit code something else already chose', () => {
    const proc = fakeProcess(3);
    guardUnfinishedRun(proc, () => {});

    proc.emit('beforeExit', 3);

    expect(proc.exitCode).toBe(3);
  });

  // The normal path: `runTests` returned, so the run's own `process.exit`
  // decides the code.
  it('does nothing once disarmed', () => {
    const proc = fakeProcess();
    const logged: string[] = [];
    const disarm = guardUnfinishedRun(proc, (message) => logged.push(message));

    disarm();
    proc.emit('beforeExit', 0);

    expect(proc.exitCode).toBeUndefined();
    expect(logged).toEqual([]);
    expect(proc.listenerCount('beforeExit')).toBe(0);
  });

  it('leaves no listener on the real process once disarmed', () => {
    const before = process.listenerCount('beforeExit');
    const disarm = guardUnfinishedRun();
    try {
      expect(process.listenerCount('beforeExit')).toBe(before + 1);
    } finally {
      disarm();
    }
    expect(process.listenerCount('beforeExit')).toBe(before);
  });
});
