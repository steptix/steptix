// A `cmd.exe` wrapper around a node that waits — the npm `bw.cmd` shape — for
// the tests that ask a real Windows process table which child is `bw`
// (credential-bw-process, credential-real-processes).
//
// The node announces itself: once it is running it writes its own PID to a
// ready file, and the caller waits for that file instead of sleeping for a
// guessed start time. On a loaded runner node can take seconds to appear under
// cmd.exe, and a lookup made before it does finds no child at all — which in
// one test was a red run and in the other a silent skip. The PID it writes is
// also the exact answer the lookup must give, not merely "some number".

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WrappedWaiter {
  /** The cmd.exe this test spawned — what the driver would have spawned. */
  wrapper: ChildProcess;
  /** The node under it, by its own account. */
  nodePid: number;
  /** Stop both, each by exact PID. Safe to call more than once. */
  stop(): void;
}

/** How long node may take to start under cmd.exe. A ceiling: it normally takes well under a second. */
const READY_CEILING_MS = 30_000;

function readPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // not written yet
  }
}

export async function startWrappedWaiter(dir: string): Promise<WrappedWaiter> {
  // The waiting script is a FILE, never `-e <code>`: cmd.exe reads `>` in an
  // arrow function as output redirection, runs something else entirely, and
  // leaves a stray file named after the rest of the code in the cwd.
  //
  // Its self-exit is a leak guard only, longer than any test that uses it, so
  // it can never stand in for a stop the test is checking.
  //
  // The PID goes to a temporary name and is renamed into place, so the ready
  // file only ever exists whole: a write read halfway would be a shorter digit
  // string, which still parses as a PID — just not this one.
  const ready = path.join(dir, 'ready.pid');
  const partial = `${ready}.tmp`;
  const waiter = path.join(dir, 'wait.cjs');
  writeFileSync(
    waiter,
    `var fs = require('fs');\n` +
      `fs.writeFileSync(${JSON.stringify(partial)}, String(process.pid));\n` +
      `fs.renameSync(${JSON.stringify(partial)}, ${JSON.stringify(ready)});\n` +
      `setTimeout(function () {}, 120000);\n`,
  );
  const wrapper = spawn(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', process.execPath, waiter], {
    windowsHide: true,
    stdio: 'ignore',
  });
  let spawnError: Error | null = null;
  wrapper.once('error', (err) => {
    spawnError = err;
  });

  const end = Date.now() + READY_CEILING_MS;
  let nodePid = readPid(ready);
  while (nodePid === null) {
    const why =
      spawnError !== null
        ? `cmd.exe did not start: ${String(spawnError)}`
        : wrapper.exitCode !== null || wrapper.signalCode !== null
          ? `cmd.exe exited (${wrapper.exitCode ?? wrapper.signalCode}) before node started under it`
          : Date.now() > end
            ? `node did not start under cmd.exe within ${READY_CEILING_MS} ms`
            : null;
    if (why !== null) {
      wrapper.kill();
      throw new Error(why);
    }
    await new Promise((r) => setTimeout(r, 50));
    nodePid = readPid(ready);
  }

  const pid = nodePid;
  return {
    wrapper,
    nodePid: pid,
    stop: () => {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
      wrapper.kill();
    },
  };
}
