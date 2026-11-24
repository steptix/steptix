/**
 * Commands an agent step runs (docs/specs/SPEC-use-agent.md §6.3–§6.5): which
 * ones may start, the environment they start with, and stopping them.
 *
 * Steptix limits what the agent is OFFERED, not what a script does once it
 * runs (§6.6). The allow list decides which commands start; nothing here
 * pretends to be a sandbox.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * The C# PowerShell compiles to put itself in a Windows Job Object that kills
 * every process in it when the job's last handle closes
 * (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, extended limit class 9). The shell
 * holds the only handle, so when it exits — or `taskkill` ends it — every
 * process the command started goes with it, including one whose own parent has
 * already exited: §6.5's "the whole tree", which a walk of the process table
 * cannot find once the parent between them is gone. Children inherit the job.
 * When the job cannot be made, the command still runs, without that guarantee.
 */
const WINDOWS_JOB_SOURCE = `using System; using System.Runtime.InteropServices;
public static class SteptixAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic B; public Io I; public UIntPtr p; public UIntPtr q; public UIntPtr r; public UIntPtr s; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static void Enter() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Extended info = new Extended();
    info.B.LimitFlags = 0x2000;
    SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)));
    AssignProcessToJobObject(job, GetCurrentProcess());
  }
}`;

/** The shell a command runs in, by platform (§6.3). */
export function shellFor(platform: NodeJS.Platform = process.platform): {
  name: string;
  file: string;
  args: (command: string) => string[];
} {
  if (platform === 'win32') {
    return {
      name: 'PowerShell',
      file: 'powershell.exe',
      // `-Command` exits 1 for any failure and 0 otherwise, so a script's own
      // exit code would be lost: `node x.js` exiting 3 reports 1. The lines
      // after the command pass the last program's code through. `$?` is read
      // first, before anything resets it, and is not trusted alone: Windows
      // PowerShell sets it false for a program whose stderr is redirected
      // (`2>&1`) even when it exits 0. A failed cmdlet with no program code
      // exits 1. A program's code can still be stale when a cmdlet ran after
      // it (`node a.js; Get-ChildItem`): the program's code wins.
      //
      // The line before the command puts the shell in a Job Object (see
      // WINDOWS_JOB_SOURCE). A single-quoted here-string, so nothing in the C#
      // is expanded; its failure is swallowed, and `$?` is reset by the
      // command that follows.
      args: (command) => [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `try { Add-Type -TypeDefinition @'\n${WINDOWS_JOB_SOURCE}\n'@; [SteptixAgentJob]::Enter() } catch { }\n` +
          `${command}\n$steptixOk = $?\n` +
          'if ($LASTEXITCODE -is [int] -and ($LASTEXITCODE -ne 0 -or -not $steptixOk)) { exit $LASTEXITCODE } ' +
          'elseif ($steptixOk) { exit 0 } else { exit 1 }',
      ],
    };
  }
  return { name: '/bin/sh', file: '/bin/sh', args: (command) => ['-c', command] };
}

/**
 * Read a command line outside its quotes: the parts `&&`, `||`, `;`, `|` and
 * new lines join, and the constructs that run a command the allow list never
 * sees. This models the quoting the two shells share — plain single and
 * double quotes — and refuses what it does not model rather than reading it
 * differently from the shell.
 *
 * A part is checked against the allow list on its own, so `python a.py && rm
 * -rf x` is not let through by `python *`. What cannot be checked part by
 * part is refused outright rather than guessed at (docs/specs/SPEC-use-agent.md
 * §16.1):
 *
 *  - `$(…)` and backticks, which run a command inside another — in sh even
 *    inside double quotes, so they are looked for there too;
 *  - `(`, `{` and `@(` outside quotes: a subshell or grouping in sh, a
 *    subexpression or script block in PowerShell, either of which runs a
 *    command inside the part (`git status (Remove-Item x)`);
 *  - a single `&` outside quotes: sh's background separator, and
 *    PowerShell's call operator (`2>&1` and `>&` are redirections, and
 *    allowed);
 *  - a bare carriage return, which PowerShell treats as a new statement;
 *  - any typographic quote (‘ ’ ‚ ‛ “ ” „), which PowerShell reads as a quote;
 *  - on Linux and macOS, a backslash outside single quotes and `$'`: sh
 *    escapes with a backslash (`\'` is not a quote) and bash's `$'…'` has
 *    escapes of its own. On Windows a backslash is a path separator, and
 *    PowerShell's escape character is the backtick, refused above.
 *
 * Single-quoted text is literal in both shells and is never looked into.
 */
function scanCommandLine(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { parts: string[]; uncheckable?: string } {
  if (/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E]/.test(command)) {
    return { parts: [], uncheckable: 'a typographic quote' };
  }
  const posix = platform !== 'win32';
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    if (current.trim() !== '') parts.push(current.trim());
    current = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === '`') return { parts, uncheckable: 'a backtick' };
    if (posix && c === '\\') return { parts, uncheckable: 'a backslash' };
    if (posix && c === '$' && next === "'" && quote === null) return { parts, uncheckable: "$'…'" };
    if (c === '$' && next === '(') return { parts, uncheckable: '$(…)' };
    if (quote === '"') {
      current += c;
      if (c === '"') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '\r' && next !== '\n') return { parts, uncheckable: 'a carriage return' };
    if (c === '(' || c === '{') return { parts, uncheckable: `"${c}" outside quotes` };
    if (c === '&' && next === '&') {
      push();
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      push();
      i++;
      continue;
    }
    if (c === '&') {
      const prev = command[i - 1];
      // `2>&1`, `>&2` and `&>file` are redirections, not a separator.
      if (prev === '>' || next === '>') {
        current += c;
        continue;
      }
      return { parts, uncheckable: 'a single "&" outside quotes' };
    }
    if (c === ';' || c === '|' || c === '\n' || c === '\r') {
      push();
      continue;
    }
    current += c;
  }
  if (quote !== null) return { parts, uncheckable: 'an unclosed quote' };
  push();
  return { parts };
}

/** The parts of a command line, each to be checked against the allow list. */
export function commandParts(command: string, platform: NodeJS.Platform = process.platform): string[] {
  return scanCommandLine(command, platform).parts;
}

/** Why the line cannot be checked part by part, or undefined when it can. */
export function uncheckableReason(command: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return scanCommandLine(command, platform).uncheckable;
}

/** True when the line runs a command inside another, which no pattern can
 *  vouch for. Kept for callers that only need the yes or no. */
export function hasSubstitution(command: string): boolean {
  return uncheckableReason(command) !== undefined;
}

/** The words of one command part, quotes respected enough to keep a quoted
 *  path with spaces in one word. */
function words(part: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of part.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** The folders a package installer puts its programs in, relative to the
 *  workspace: a program there is the program it is named after. */
const INSTALLED_BIN_RE = /^(?:\.\/)?(?:\.?venv[\\/](?:Scripts|bin)|node_modules[\\/]\.bin)[\\/][^\\/]+$/i;

/**
 * A program as the allow list sees it. A bare name, or one in a virtual
 * environment's or `node_modules`' bin folder, is reduced to its name without
 * a Windows launcher extension, so `.venv/Scripts/pip.exe` and `pip` are the
 * same program. Any other path is kept as written: a file the agent wrote
 * elsewhere and named `git.cmd` is not `git`, and matches only a pattern
 * that names its path.
 */
export function programName(word: string): string {
  if (/[\\/]/.test(word) && !INSTALLED_BIN_RE.test(word)) return word.replace(/\\/g, '/');
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

/** One command part with its program reduced to its name: what the allow list
 *  and the remembered answers are matched against. */
export function normaliseCommand(part: string): string {
  const w = words(part.trim());
  if (w.length === 0) return '';
  return [programName(w[0]!), ...w.slice(1)].join(' ');
}

/** A plain subcommand word: no path, no dot, no leading dash (§6.3). */
const SUBCOMMAND_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * The pattern a "for the rest of this run" answer covers (§6.3): the program,
 * plus its subcommand when the second word is a plain word. Shown in the
 * question, so the person sees exactly what they are allowing.
 */
export function patternFor(part: string): string {
  const w = words(part.trim());
  if (w.length === 0) return '';
  const program = programName(w[0]!);
  const second = w[1];
  return second !== undefined && SUBCOMMAND_RE.test(second) ? `${program} ${second} *` : `${program} *`;
}

/** `pattern` as an anchored, case-insensitive regex: `*` is any text,
 *  including none, so `node *` also matches a bare `node`. */
function patternRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const body = trimmed
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
    // `node *` must match `node` alone, so a space before a trailing `.*` is
    // optional.
    .replace(/ \.\*$/, '(?: .*)?');
  return new RegExp(`^${body}$`, 'i');
}

/** True when the (normalised) command part matches the pattern. */
export function matchesPattern(part: string, pattern: string): boolean {
  return patternRegex(pattern).test(normaliseCommand(part));
}

/** The first pattern in `patterns` the part matches, or undefined. */
export function matchingPattern(part: string, patterns: readonly string[]): string | undefined {
  return patterns.find((p) => matchesPattern(part, p));
}

/** A global package install, which Steptix refuses: packages install into the
 *  workspace, never into the machine (§6.3). */
export function isGlobalInstall(part: string): boolean {
  const w = words(normaliseCommand(part)).map((x) => x.toLowerCase());
  const program = w[0];
  const rest = w.slice(1);
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
    if (program === 'yarn' && rest[0] === 'global') return true;
    return rest.some((x) => x === '-g' || x === '--global' || x === '--location=global');
  }
  return false;
}

/** Environment variables a program needs to start on this platform (§6.4),
 *  by name, case-insensitively. Everything else is withheld. */
const PASSED_THROUGH = new Set(
  [
    'PATH',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SYSTEMROOT',
    'SYSTEMDRIVE',
    'WINDIR',
    'COMSPEC',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'USER',
    'USERNAME',
    'LOGNAME',
    'SHELL',
    'TERM',
  ].map((n) => n.toUpperCase()),
);

/** The variable a secret is handed to commands under (§6.4):
 *  `api_token` → `STEPTIX_SECRET_API_TOKEN`. */
export function secretEnvName(name: string): string {
  return `STEPTIX_SECRET_${name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/**
 * The scrubbed environment a command starts with (§6.4): the platform's own
 * variables, `PIP_REQUIRE_VIRTUALENV=1` so `pip install` works only inside a
 * virtual environment, and each secret by its `STEPTIX_SECRET_*` name.
 * Steptix's own keys never reach a script.
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSED_THROUGH.has(key.toUpperCase())) env[key] = value;
  }
  env['PIP_REQUIRE_VIRTUALENV'] = '1';
  for (const [name, value] of Object.entries(secrets)) env[secretEnvName(name)] = value;
  return env;
}

/** What one command did. `output` is stdout and stderr interleaved, up to
 *  {@link OUTPUT_KEEP_BYTES}; `outputBytes` is how much there was. */
export interface CommandRun {
  exitCode: number | null;
  /** Why it stopped early, when it did. */
  stopped?: 'timeout' | 'aborted';
  output: string;
  outputBytes: number;
  durationMs: number;
}

/** Output kept in memory per command, for the report's log copy. A command
 *  that prints more is cut, and the copy says so. */
export const OUTPUT_KEEP_BYTES = 5 * 1024 * 1024;

/** How long a command's result waits for its output pipes after the shell has
 *  exited or been killed, before it settles without them. */
const DRAIN_MS = 2000;

/**
 * Kill a command's whole process tree (§6.5), including processes that
 * outlived the shell. On Linux and macOS, the process group: the shell is
 * spawned detached, so it leads its own group, and the group outlives its
 * leader. On Windows, `taskkill /T /F` on the shell, whose Job Object then
 * closes and takes every process in it — the ones `/T` cannot reach because
 * their parent has exited included. Never throws: a tree that already exited
 * is fine.
 */
export async function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => resolve());
      killer.on('exit', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is gone already
  }
}

export interface RunCommandArgs {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  platform?: NodeJS.Platform;
}

/** Run one command line in the platform shell, killing its tree on timeout or
 *  abort. Resolves; never rejects for the command's own failure. */
export function runCommand(args: RunCommandArgs): Promise<CommandRun> {
  const platform = args.platform ?? process.platform;
  const shell = shellFor(platform);
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args(args.command), {
        cwd: args.cwd,
        env: args.env,
        windowsHide: true,
        // Its own process group on POSIX, so killTree reaches its children.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        output: `Could not start ${shell.name}: ${err instanceof Error ? err.message : String(err)}`,
        outputBytes: 0,
        durationMs: Date.now() - started,
      });
      return;
    }
    const chunks: Buffer[] = [];
    let kept = 0;
    let total = 0;
    const take = (chunk: Buffer): void => {
      total += chunk.length;
      if (kept >= OUTPUT_KEEP_BYTES) return;
      const room = OUTPUT_KEEP_BYTES - kept;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      kept += piece.length;
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    let stopped: CommandRun['stopped'];
    let settled = false;
    let exitCode: number | null = null;
    /** Settle without waiting for `close`: a process that outlived the shell
     *  can hold the output pipes open for ever. */
    let drainTimer: NodeJS.Timeout | undefined;
    const stop = (why: 'timeout' | 'aborted'): void => {
      if (stopped !== undefined) return;
      stopped = why;
      void killTree(child, platform).then(() => {
        drainTimer ??= setTimeout(() => finish(exitCode), DRAIN_MS);
      });
    };
    const timer = setTimeout(() => stop('timeout'), args.timeoutMs);
    const onAbort = (): void => stop('aborted');
    if (args.signal?.aborted) onAbort();
    else args.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      const exitCode = code;
      args.signal?.removeEventListener('abort', onAbort);
      let output = Buffer.concat(chunks).toString('utf8');
      if (extra) output += (output === '' ? '' : '\n') + extra;
      resolve({
        exitCode,
        ...(stopped !== undefined && { stopped }),
        output,
        outputBytes: total,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => finish(null, `Could not start ${shell.name}: ${err.message}`));
    // When the shell exits, whatever it left running goes too (§6.5: the step
    // ends with nothing it started still running) — the group is killed on
    // Linux and macOS, and on Windows the shell's Job Object has closed with
    // it. The result settles once the pipes drain, or after DRAIN_MS, since a
    // process nothing could reach may still hold them.
    child.on('exit', (code) => {
      exitCode = code;
      void killTree(child, platform).then(() => {
        drainTimer ??= setTimeout(() => finish(exitCode), DRAIN_MS);
      });
    });
    // `close`, not `exit`, settles normally: the streams are drained by then.
    child.on('close', (code) => finish(code ?? exitCode));
  });
}

/** The command's folder as the question and the report show it: relative to
 *  the project when inside it. */
export function displayFolder(folder: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, folder);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : folder;
}
