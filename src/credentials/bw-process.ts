// Which process IS `bw`? (stories/bitwarden-sign-in.md §4.4)
//
// The login driver must be able to stop `bw` in every state it can reach, and
// in one of them — the SSO step, where `bw` has closed its prompts and holds a
// localhost listener with no timeout — neither ending its stdin nor killing
// the process we spawned stops it (story §1 fact 10). The only thing that does
// is killing `bw` itself by PID. And the process we spawn is often not `bw`:
// an npm `bw.cmd` runs inside a `cmd.exe` wrapper, and a Scoop or Chocolatey
// `bw.exe` is a shim that starts the real CLI as its own child.
//
// So this file answers one question — "which child of the process we spawned
// is `bw`?" — and the answer is only trusted when it is unambiguous. Matching
// on parent PID alone is not safe on Windows: a process whose parent died long
// ago keeps that dead parent's PID as its ParentProcessId, and if Windows has
// since handed the same PID to our child, the stale process looks like ours.
// Killing it is exactly the incident the fleet's own history records. The
// creation-time filter below is what rules that out: the stale process was
// created while its real parent was alive, and Windows does not reuse a PID
// while its holder lives, so it predates our child. Anything created at or
// after our child started cannot be such a leftover.

import { spawn } from 'node:child_process';

/** One row of the process table, as far as this file reads it. */
export interface ProcessRow {
  pid: number;
  parentPid: number;
  /** Image name, e.g. `node.exe`. */
  name: string;
  /** Creation time in 100ns ticks — exact, so no rounding can blur the filter. */
  created: bigint;
}

/** The process we spawned: the parent whose children are being asked about. */
export interface SpawnedProcess {
  pid: number;
  created: bigint;
}

/**
 * What `pickBwChild` concluded.
 *
 * - a PID: exactly one real child — that is `bw`.
 * - `'self'`: no children at all. Whether the spawned process can then be `bw`
 *   depends on what was spawned, which only the driver knows (a `cmd.exe`
 *   wrapper with no child is anomalous; a standalone `bw.exe` is `bw`).
 * - `null`: ambiguous — two or more candidates. Never guess between them.
 */
export type BwPick = number | 'self' | null;

/**
 * The console host Windows attaches to a console process. A child of our
 * wrapper in the process table, never the program we launched.
 */
const CONSOLE_HOST = 'conhost.exe';

/** Pure: choose `bw` from a process table. The whole of the safety rule. */
export function pickBwChild(rows: readonly ProcessRow[], spawned: SpawnedProcess): BwPick {
  const candidates = rows.filter(
    (row) =>
      row.parentPid === spawned.pid &&
      row.pid !== spawned.pid &&
      row.created >= spawned.created &&
      row.name.toLowerCase() !== CONSOLE_HOST,
  );
  if (candidates.length === 0) return 'self';
  if (candidates.length === 1) return candidates[0]!.pid;
  return null;
}

/** How long the process-table query may take before it counts as "not found". */
export const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The query. The PID reaches the script through the environment, never the
 * script text — the same rule approval.ts keeps for every value it shows.
 *
 * Output, one line each: `SELF|<pid>|<ticks>` for the spawned process, then
 * `CHILD|<pid>|<parent>|<name>|<ticks>` per child. Creation times as
 * `DateTime.Ticks` (UTC): integers, compared exactly.
 */
const LOOKUP_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [int]$env:AIUI_BW_PARENT_PID
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$target"
if ($null -eq $self) { exit 3 }
[Console]::Out.WriteLine('SELF|' + $self.ProcessId + '|' + $self.CreationDate.ToUniversalTime().Ticks)
foreach ($c in Get-CimInstance Win32_Process -Filter "ParentProcessId=$target") {
  [Console]::Out.WriteLine('CHILD|' + $c.ProcessId + '|' + $c.ParentProcessId + '|' + $c.Name + '|' + $c.CreationDate.ToUniversalTime().Ticks)
}
exit 0
`;

/** Parse the lookup's output. Anything malformed makes the whole answer void. */
export function parseLookup(stdout: string): { spawned: SpawnedProcess; rows: ProcessRow[] } | null {
  let spawned: SpawnedProcess | null = null;
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') continue;
    const parts = line.split('|');
    try {
      if (parts[0] === 'SELF' && parts.length === 3) {
        spawned = { pid: Number.parseInt(parts[1]!, 10), created: BigInt(parts[2]!) };
      } else if (parts[0] === 'CHILD' && parts.length === 5) {
        rows.push({
          pid: Number.parseInt(parts[1]!, 10),
          parentPid: Number.parseInt(parts[2]!, 10),
          name: parts[3]!,
          created: BigInt(parts[4]!),
        });
      } else {
        return null;
      }
    } catch {
      return null; // BigInt of a non-integer
    }
  }
  if (!spawned || !Number.isInteger(spawned.pid)) return null;
  if (rows.some((r) => !Number.isInteger(r.pid) || !Number.isInteger(r.parentPid))) return null;
  return { spawned, rows };
}

/**
 * Find `bw` under the process we spawned. Windows only; the driver never calls
 * it elsewhere.
 *
 * Resolves `null` — "not found" — for every failure: the query timing out
 * (its own PowerShell is killed first), PowerShell failing to start, the
 * spawned process already gone, or output that does not parse. The driver
 * treats "not found" by stopping before it writes anything, so a failure here
 * can only ever cost a sign-in, never leave a `bw` it cannot stop.
 */
export function findBwProcess(spawnedPid: number, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<BwPick> {
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: BwPick): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(LOOKUP_SCRIPT, 'utf16le').toString('base64')],
        {
          shell: false,
          windowsHide: true,
          env: { ...process.env, AIUI_BW_PARENT_PID: String(spawnedPid) },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const parsed = parseLookup(stdout);
      // A table describing some other process than the one asked about is not
      // an answer about ours.
      if (!parsed || parsed.spawned.pid !== spawnedPid) return finish(null);
      finish(pickBwChild(parsed.rows, parsed.spawned));
    });
  });
}
