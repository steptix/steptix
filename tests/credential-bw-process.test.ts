// Which process is `bw` (stories/bitwarden-sign-in.md §4.4, tests §10.2
// 32–34, and the lookup timeout of test 17).
//
// `pickBwChild` carries the whole of the safety rule, so it is tested as a
// pure function over hand-built process tables — including the one row that
// matters most: a stale process whose dead parent once had our child's PID.
// Killing that process is the incident this project's history records; the
// creation-time filter is what prevents it.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBwProcess, parseLookup, pickBwChild, type ProcessRow } from '../src/credentials/bw-process.js';

const SPAWNED = { pid: 500, created: 1_000_000n };

function row(pid: number, over: Partial<ProcessRow> = {}): ProcessRow {
  return { pid, parentPid: SPAWNED.pid, name: 'node.exe', created: SPAWNED.created + 10n, ...over };
}

describe('pickBwChild — the rule', () => {
  it('32. one child created after the spawned process is bw; conhost beside it is ignored', () => {
    expect(pickBwChild([row(600), row(601, { name: 'conhost.exe' })], SPAWNED)).toBe(600);
    expect(pickBwChild([row(601, { name: 'CONHOST.EXE' }), row(600)], SPAWNED)).toBe(600);
  });

  it('33. EXCLUDES a child of the same PID created before the spawned process — the stale-PID case', () => {
    // Created before our child existed, so its real parent was some earlier
    // process that held PID 500 and has since died. It is not ours.
    const stale = row(700, { created: SPAWNED.created - 1n });
    expect(pickBwChild([stale], SPAWNED)).toBe('self');
    expect(pickBwChild([stale, row(600)], SPAWNED)).toBe(600);
  });

  it('33. accepts a child created in the same tick as the spawned process', () => {
    expect(pickBwChild([row(600, { created: SPAWNED.created })], SPAWNED)).toBe(600);
  });

  it('34. no candidates is "self"; two is ambiguous and never guessed between', () => {
    expect(pickBwChild([], SPAWNED)).toBe('self');
    expect(pickBwChild([row(600), row(601)], SPAWNED)).toBeNull();
  });

  it('ignores rows that are not children of the spawned process at all', () => {
    expect(pickBwChild([row(600, { parentPid: 999 })], SPAWNED)).toBe('self');
  });
});

describe('parseLookup — output is trusted only when all of it parses', () => {
  it('reads the spawned process and its children, times as exact ticks', () => {
    const parsed = parseLookup(
      'SELF|500|638912345678901234\r\nCHILD|600|500|node.exe|638912345678901299\r\n',
    );
    expect(parsed).toEqual({
      spawned: { pid: 500, created: 638912345678901234n },
      rows: [{ pid: 600, parentPid: 500, name: 'node.exe', created: 638912345678901299n }],
    });
  });

  it('voids the whole answer on any malformed line', () => {
    expect(parseLookup('SELF|500|123\nCHILD|600|500|node.exe|not-a-number\n')).toBeNull();
    expect(parseLookup('SELF|500|123\nSOMETHING ELSE\n')).toBeNull();
    expect(parseLookup('CHILD|600|500|node.exe|123\n')).toBeNull(); // no SELF line
    expect(parseLookup('')).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('findBwProcess — against the real process table', () => {
  it('17. answers "not found" when the lookup outlives its timeout', async () => {
    // 1ms: PowerShell cannot even start in that time, so only the timeout can
    // produce this answer. Its own PowerShell is killed on the way out.
    await expect(findBwProcess(process.pid, 1)).resolves.toBeNull();
  });

  it('answers "not found" for a PID that is not running', async () => {
    await expect(findBwProcess(0)).resolves.toBeNull();
    await expect(findBwProcess(-5)).resolves.toBeNull();
  });

  it('finds the one real child of a process this test spawned itself', { timeout: 30_000 }, async () => {
    // A cmd.exe wrapper around a node that waits — the npm `bw.cmd` shape.
    // Both are this test's own processes, and both are stopped by exact PID.
    //
    // The waiting script is a FILE, never `-e <code>`: cmd.exe reads `>` in
    // an arrow function as output redirection, runs something else entirely,
    // and leaves a stray file named after the rest of the code in the cwd.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-process-'));
    const waiter = path.join(dir, 'wait.cjs');
    writeFileSync(waiter, 'setTimeout(function () {}, 20000);\n');
    const wrapper = spawn(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', process.execPath, waiter], {
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let node start under it
      const pick = await findBwProcess(wrapper.pid!);
      expect(typeof pick).toBe('number');
      expect(pick).not.toBe(wrapper.pid);
      if (typeof pick === 'number') process.kill(pick);
    } finally {
      wrapper.kill();
    }
  });
});
