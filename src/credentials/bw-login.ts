// The login driver: one `bw login --raw` process, its prompts answered from
// what the user typed into the sign-in dialog (stories/bitwarden-sign-in.md §4).
//
// Why a driver and not flags: `bw login` has no flag for the new-device code
// Bitwarden emails to an account without two-step login, and email two-step
// sends its email mid-login and then prompts — so for many accounts the only
// way in is to answer `bw`'s own interactive prompts (story §1 fact 1). This
// file does that over a pipe, which was measured to work (fact 3).
//
// The four rules that shape it:
//
//  1. **Nothing the user typed is an argument.** argv is `login --raw`, always.
//     The email and password go to prompts, down stdin.
//  2. **`bw`'s own output never leaves this file.** It echoes the email and any
//     code back to stderr in clear (fact 4). What comes out is a category, and
//     on success a session key — never a line `bw` printed.
//  3. **An echo is not a re-ask.** `bw` re-renders a prompt once per character
//     it echoes, AFTER reading our answer. Treating that as `bw` asking again
//     would end every real sign-in at its first prompt.
//  4. **Never write a secret to a `bw` this file could not stop.** In the SSO
//     state `bw` ignores stdin and survives the death of the process we
//     spawned (fact 10), so on Windows we find `bw`'s own PID before writing
//     anything, and stop at the email prompt if we cannot.

import { spawn as nodeSpawn } from 'node:child_process';
import { bwLaunch } from './vault.js';
import { findBwProcess as realFindBwProcess, type BwPick } from './bw-process.js';

/** A code dialog's two flavours, which differ only in what they tell the user. */
export type CodeKind = 'two-step' | 'new-device';

/** Everything a login can end as. `signed-in` alone carries a value. */
export type DriverResult =
  | { kind: 'signed-in'; sessionKey: string }
  | { kind: DriverFailure };

export type DriverFailure =
  | 'cancelled'
  | 'rejected'
  | 'code-rejected'
  | 'unsupported-step'
  | 'timed-out'
  | 'failed'
  /** `bw` already holds an account: the vault is locked, not signed out. */
  | 'already-signed-in'
  /** `bw` went silent after an answer — SSO, or a slow post-login sync. §4.6 decides. */
  | 'quiet';

/**
 * What a test may observe: which prompts were answered, and how it ended.
 * KINDS ONLY — no value, no text from `bw`, ever. Production passes no observer.
 */
export type DriverEvent =
  | { answered: 'email' | 'password' | CodeKind }
  | { stopped: DriverResult['kind'] };

/** The subset of a child process the driver uses. A seam for the fake child. */
export interface LoginChild {
  readonly pid?: number | undefined;
  readonly stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
  } | null;
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(): unknown;
}

export interface DriveLoginOptions {
  /** The resolved `bw` binary (`resolveBinary`). */
  binary: string;
  /** The ambient environment; the child's is derived from it (`loginEnv`). */
  environment: NodeJS.ProcessEnv;
  /** From the sign-in dialog. Held only for the life of this call. */
  credentials: { email: string; password: string };
  /** Raise the code dialog. Resolves the code, or null if cancelled or timed out. */
  askCode: (kind: CodeKind) => Promise<string | null>;
  /** Seams — all default to the real thing. */
  spawn?: (command: string, args: string[], env: NodeJS.ProcessEnv) => LoginChild;
  findBwProcess?: (spawnedPid: number) => Promise<BwPick>;
  killPid?: (pid: number) => void;
  platform?: NodeJS.Platform;
  quietMs?: number;
  deadlineMs?: number;
  onEvent?: (event: DriverEvent) => void;
}

/** 60s: every legitimate step answers far sooner; the SSO step never does. */
export const QUIET_MS = 60_000;
/** 6 min: the code dialog's 180s, `bw`'s start and network, and margin. */
export const DEADLINE_MS = 6 * 60_000;

/**
 * Variables that change what `bw` prints, how it exits, or whether it prompts
 * (story §1 facts 2 and 5). Removed from the child's environment in any
 * casing: a copied `process.env` is a plain object, so on Windows an exact-key
 * `delete` would leave `Bw_NoInteraction` behind.
 */
const STRIPPED_VARS = new Set([
  'BW_NOINTERACTION',
  'BW_QUIET',
  'BW_RESPONSE',
  'BW_CLEANEXIT',
  'BW_PRETTY',
  'BW_RAW',
  'BW_SESSION',
]);

/** The login child's environment. Exported so the rule is testable directly. */
export function loginEnv(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (!STRIPPED_VARS.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

type PromptKind = 'email' | 'password' | CodeKind | 'method-list' | 'unknown';

/** Classify one render by how it begins (story §4.2's table). */
function promptKind(render: string): PromptKind {
  const text = render.trimStart();
  if (text.startsWith('Email address:')) return 'email';
  if (text.startsWith('Master password:')) return 'password';
  if (text.startsWith('Two-step login code:')) return 'two-step';
  if (text.startsWith('New device verification required')) return 'new-device';
  if (text.startsWith('Two-step login method:')) return 'method-list';
  return 'unknown';
}

/** CSI sequences and carriage returns: what inquirer draws with. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g;
/** An escape sequence cut off by a chunk boundary, still waiting for its end. */
const PARTIAL_ANSI = /\x1b(\[[0-9;?]*[ -/]*)?$/;

/**
 * The text `bw` printed that is not a prompt: its final message. Render lines
 * (`? …`, echoes included) are removed first, so an echoed email that happens
 * to contain a word like "invalid" cannot steer the classification.
 */
function finalMessage(cleanStderr: string, stdout: string): string {
  return `${cleanStderr.replace(/\? [^\n]*/g, '')}\n${stdout}`;
}

/** Classify a non-zero exit (story §4.4). Fixed categories; the text is dropped. */
function classifyExit(message: string): DriverFailure {
  if (/you are already logged in/i.test(message)) return 'already-signed-in';
  if (/invalid master password|username or password is incorrect/i.test(message)) return 'rejected';
  if (
    /invalid (email or )?verification code|(invalid|incorrect)[^\n]*(two-step|verification)|(two-step|verification)[^\n]*(invalid|incorrect)/i.test(
      message,
    )
  ) {
    return 'code-rejected';
  }
  return 'failed';
}

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): LoginChild {
  // `shell: false`: argv is fixed literals, but there is still no reason to
  // give a shell a look at it. `windowsHide` so no console flashes.
  return nodeSpawn(command, args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function defaultKillPid(pid: number): void {
  process.kill(pid);
}

/**
 * Run one `bw login --raw` and answer its prompts. Never rejects: every way it
 * can end is a `DriverResult`.
 */
export function driveLogin(opts: DriveLoginOptions): Promise<DriverResult> {
  const platform = opts.platform ?? process.platform;
  const spawnChild = opts.spawn ?? defaultSpawn;
  const killPid = opts.killPid ?? defaultKillPid;
  const quietMs = opts.quietMs ?? QUIET_MS;
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  const emit = opts.onEvent ?? (() => {});
  const findBw = opts.findBwProcess ?? realFindBwProcess;

  // One value, one prompt. A line break inside a value would be read by `bw`
  // as the answer to the NEXT prompt too — so no such value is ever written.
  // The dialogs are single-line and a user cannot type one; this is for the
  // paste that carried one in.
  if (/[\r\n]/.test(opts.credentials.email) || /[\r\n]/.test(opts.credentials.password)) {
    emit({ stopped: 'failed' });
    return Promise.resolve({ kind: 'failed' });
  }

  const env = loginEnv(opts.environment);
  const launch = bwLaunch(opts.binary, ['login', '--raw'], env, platform);
  const wrapped = launch.command !== opts.binary;

  return new Promise<DriverResult>((resolve) => {
    let settled = false;
    let spawnedExited = false;
    /** `bw`'s own PID when it is not the process we spawned. */
    let bwPid: number | null = null;
    /** Whether `bw` has been identified yet (always true off Windows). */
    let identified = platform !== 'win32';

    let raw = ''; // all stderr so far, unprocessed escapes and all
    let consumed = 0; // index into the ANSI-stripped stderr already handled
    let stdout = '';

    const answered = new Set<PromptKind>();
    let lastAnswered: PromptKind | null = null;
    /** The code prompt whose dialog is open right now. */
    let pendingCode: CodeKind | null = null;
    /** Set while awaiting the PID lookup or a code dialog: stderr just queues. */
    let busy = false;

    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop('timed-out'), deadlineMs);

    let child: LoginChild;
    try {
      child = spawnChild(launch.command, launch.args, env);
    } catch {
      clearTimeout(deadline);
      settled = true;
      emit({ stopped: 'failed' });
      resolve({ kind: 'failed' });
      return;
    }

    // A write can race `bw` exiting; the resulting EPIPE is not an event anyone
    // needs to hear about, and unhandled it would crash the server.
    child.stdin?.on('error', () => {});

    function settle(result: DriverResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      emit({ stopped: result.kind });
      resolve(result);
    }

    /**
     * Stop `bw` in whatever state it is in (story §4.4): end stdin (enough at a
     * prompt), kill `bw` by PID (the only thing that works in the SSO state),
     * kill what we spawned. The PID is used only while the process we spawned
     * is still alive: a wrapper or shim outlives its child, so once it has
     * exited the PID may already belong to someone else.
     */
    function stop(kind: DriverFailure): void {
      if (settled) return;
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      if (bwPid !== null && !spawnedExited) {
        try {
          killPid(bwPid);
        } catch {
          // already gone
        }
      }
      try {
        child.kill();
      } catch {
        // already gone
      }
      settle({ kind });
    }

    function write(text: string): void {
      if (settled) return;
      child.stdin?.write(text);
    }

    function armQuiet(): void {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => stop('quiet'), quietMs);
    }

    function answer(kind: 'email' | 'password' | CodeKind, value: string): void {
      write(`${value}\n`);
      answered.add(kind);
      lastAnswered = kind;
      emit({ answered: kind });
      armQuiet();
    }

    /**
     * Before the first answer on Windows: which process is `bw`? Resolves true
     * when the driver may go on writing.
     */
    async function identify(): Promise<boolean> {
      const pid = child.pid;
      let pick: BwPick = null;
      if (pid !== undefined) {
        try {
          pick = await findBw(pid);
        } catch {
          pick = null;
        }
      }
      if (settled) return false;
      if (typeof pick === 'number') {
        bwPid = pick;
      } else if (pick === 'self' && !wrapped) {
        // A standalone `bw.exe` with no child: what we spawned IS `bw`, and
        // `child.kill()` stops it.
      } else {
        // Ambiguous, missing, or a `cmd.exe` wrapper with no program under it.
        // Nothing has been written, `bw` is at a prompt, and ending stdin is
        // enough to stop it there — so stop now, before any secret goes in.
        stop('failed');
        return false;
      }
      identified = true;
      return true;
    }

    /** Handle one complete render. Resolves false when the driver has stopped. */
    async function handle(render: string): Promise<boolean> {
      const kind = promptKind(render);
      if (kind === lastAnswered || kind === pendingCode) return true; // an echo
      if (kind === 'unknown' || kind === 'method-list') {
        stop('unsupported-step');
        return false;
      }
      if (answered.has(kind)) {
        // Asked again after a different prompt came between: an answer was
        // refused. Never answer twice.
        stop('failed');
        return false;
      }
      clearTimeout(quietTimer); // a new prompt: `bw` is not stuck
      if (!identified && !(await identify())) return false;

      if (kind === 'email') {
        answer('email', opts.credentials.email);
      } else if (kind === 'password') {
        answer('password', opts.credentials.password);
      } else {
        pendingCode = kind;
        let code: string | null;
        try {
          code = await opts.askCode(kind);
        } catch {
          code = null;
        }
        // A dialog that answers after the driver stopped — deadline, `bw`
        // exiting — is discarded: nothing is written to a finished login.
        if (settled) return false;
        if (code === null) {
          stop('cancelled');
          return false;
        }
        if (/[\r\n]/.test(code)) {
          stop('failed');
          return false;
        }
        answer(kind, code);
        pendingCode = null;
      }
      return true;
    }

    /**
     * Read every complete render not yet handled, in order (story §4.2). A
     * render is complete once it contains a `:` or another render follows it.
     * Splitting runs over everything unconsumed, so a chunk boundary anywhere —
     * mid-prompt, or inside the `? ` itself — joins up on the next chunk.
     */
    async function pump(): Promise<void> {
      if (busy || settled) return;
      busy = true;
      try {
        for (;;) {
          const clean = raw.replace(PARTIAL_ANSI, '').replace(ANSI, '');
          const text = clean.slice(consumed);
          const start = text.indexOf('? ');
          if (start < 0) {
            // No render begins here. Keep a trailing '?' — it may be the first
            // half of the next delimiter.
            consumed += text.endsWith('?') ? text.length - 1 : text.length;
            return;
          }
          const next = text.indexOf('? ', start + 2);
          const render = next >= 0 ? text.slice(start + 2, next) : text.slice(start + 2);
          if (next < 0 && !render.includes(':')) {
            consumed += start; // incomplete: wait for the rest
            return;
          }
          consumed += next >= 0 ? next : text.length;
          if (!(await handle(render))) return;
        }
      } finally {
        busy = false;
      }
    }

    function onStderr(chunk: unknown): void {
      raw += String(chunk);
      // Each await inside pump can let more stderr arrive; drain until idle.
      void (async () => {
        while (!busy && !settled) {
          const before = consumed;
          const beforeLen = raw.length;
          await pump();
          if (consumed === before && raw.length === beforeLen) break;
        }
      })();
    }

    child.stderr?.on('data', onStderr);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => {
      spawnedExited = true;
      stop('failed');
    });
    child.on('close', (code) => {
      spawnedExited = true;
      if (settled) return;
      if (code === 0) {
        const tokens = stdout.trim().split(/\s+/).filter((t) => t !== '');
        settle(tokens.length === 1 ? { kind: 'signed-in', sessionKey: tokens[0]! } : { kind: 'failed' });
        return;
      }
      const clean = raw.replace(ANSI, '');
      settle({ kind: classifyExit(finalMessage(clean, stdout)) });
    });
  });
}
