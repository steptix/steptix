// The login driver (stories/bitwarden-sign-in.md §4, tests §10.1).
//
// Every test here runs against a scripted fake child — no `bw`, no dialog, no
// real PID is ever signalled (`killPid` is always a spy). The fake reproduces
// what the real `bw` 2026.6.0 was measured to do (story §1 fact 4): each prompt
// is drawn on stderr as `? <text>`, and after reading an answer inquirer
// re-draws the prompt once per character it echoes. The driver has to answer
// the first draw and ignore the rest; half of what is pinned here is that it
// does not mistake an echo for `bw` asking again.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEADLINE_MS,
  QUIET_MS,
  driveLogin,
  loginEnv,
  type DriveLoginOptions,
  type DriverEvent,
  type DriverResult,
  type LoginChild,
} from '../src/credentials/bw-login.js';

const EMAIL = 'paul@example.com';
const PASSWORD = 'correct-horse-battery-staple-9931';
const CODE = '482913';
const KEY = 'c2Vzc2lvbi1rZXktZnJvbS1idw==';
const BW_CMD = 'C:\\tools\\bw.cmd';

/** What inquirer draws before each prompt: clear the line, go to column 0. */
const REDRAW = '\x1b[2K\x1b[G';

/** A child process that records everything done to it and emits on command. */
class FakeChild extends EventEmitter implements LoginChild {
  pid = 1000;
  readonly writes: string[] = [];
  stdinEnded = false;
  kills = 0;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** Called after each stdin write, so a test can script `bw`'s echo. */
  onWrite: ((text: string) => void) | undefined;
  readonly stdin = {
    write: (text: string) => {
      this.writes.push(text);
      this.onWrite?.(text);
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
    on: () => this.stdin,
  };
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  /** Emit stderr as `bw` would. */
  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }
  /** Print a prompt the way inquirer first draws it. */
  prompt(text: string): void {
    this.err(`${REDRAW}? ${text} `);
  }
  /** inquirer's echo of a plain answer: one redraw per character. */
  echo(promptText: string, answer: string): void {
    for (let i = 1; i <= answer.length; i++) this.err(`${REDRAW}? ${promptText} ${answer.slice(0, i)}`);
    this.err('\n');
  }
  exit(code: number | null, stdout = ''): void {
    if (stdout) this.stdout.emit('data', Buffer.from(stdout));
    this.emit('close', code);
  }
}

/** Let every pending promise chain run. Real setImmediate: only setTimeout is faked. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

interface Harness {
  child: FakeChild;
  result: Promise<DriverResult>;
  events: DriverEvent[];
  spawn: ReturnType<typeof vi.fn>;
  findBwProcess: ReturnType<typeof vi.fn>;
  killPid: ReturnType<typeof vi.fn>;
  askCode: ReturnType<typeof vi.fn>;
  /** Resolves when the driver has settled — or reports that it has not. */
  settledYet(): Promise<boolean>;
}

function drive(overrides: Partial<DriveLoginOptions> = {}, child = new FakeChild()): Harness {
  const events: DriverEvent[] = [];
  const spawn = vi.fn(() => child);
  const findBwProcess = vi.fn(async () => 4242 as number | 'self' | null);
  const killPid = vi.fn();
  const askCode = vi.fn(async () => CODE as string | null);
  let done = false;
  const result = driveLogin({
    binary: BW_CMD,
    environment: { PATH: 'C:\\tools', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    credentials: { email: EMAIL, password: PASSWORD },
    askCode,
    spawn,
    findBwProcess,
    killPid,
    platform: 'win32',
    onEvent: (e) => events.push(e),
    ...overrides,
  }).finally(() => {
    done = true;
  });
  return {
    child,
    result,
    events,
    spawn,
    findBwProcess,
    killPid,
    askCode,
    settledYet: async () => {
      await flush();
      return done;
    },
  };
}

/** Script the whole happy path's stderr, echo and all, as the real `bw` draws it. */
function scriptEchoingBw(child: FakeChild): void {
  child.onWrite = (text) => {
    const value = text.replace(/\n$/, '');
    if (value === EMAIL) {
      child.echo('Email address:', value);
      child.prompt('Master password: [input is hidden]');
    } else if (value === PASSWORD) {
      // The masked prompt's one redraw after reading the answer.
      child.err(`${REDRAW}? Master password: [hidden]\n`);
    } else if (value === CODE) {
      child.echo('Two-step login code:', value);
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('answering the prompts', () => {
  it('1. signs in with no two-step: email, then password, then the session key', async () => {
    const h = drive();
    h.child.prompt('Email address:');
    await flush();
    expect(h.child.writes).toEqual([`${EMAIL}\n`]);
    h.child.prompt('Master password: [input is hidden]');
    await flush();
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
    h.child.exit(0, `${KEY}\n`);

    await expect(h.result).resolves.toEqual({ kind: 'signed-in', sessionKey: KEY });
    expect(h.events).toEqual([
      { answered: 'email' },
      { answered: 'password' },
      { stopped: 'signed-in' },
    ]);
  });

  it('2. treats the echo as an echo — and still reaches and answers the password prompt', async () => {
    // The shape that would kill every real sign-in if the echo were read as a
    // re-ask: after the email is written, "Email address:" is drawn again once
    // per character. A driver that stops on that never writes the password.
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.exit(0, `${KEY}\n`);

    await expect(h.result).resolves.toEqual({ kind: 'signed-in', sessionKey: KEY });
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
    expect(h.child.kills).toBe(0);
    expect(h.child.stdinEnded).toBe(false);
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('3. waits out a chunk boundary inside a prompt, or inside the "? " itself', async () => {
    const h = drive();
    h.child.err(`${REDRAW}? Email ad`);
    await flush();
    expect(h.child.writes).toEqual([]); // not judged unknown, not answered yet
    expect(await h.settledYet()).toBe(false);
    h.child.err('dress: ');
    await flush();
    expect(h.child.writes).toEqual([`${EMAIL}\n`]);

    h.child.err(`\n${REDRAW}?`);
    await flush();
    expect(h.child.writes).toHaveLength(1);
    h.child.err(' Master password: [input is hidden] ');
    await flush();
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
    h.child.exit(0, `${KEY}\n`);
    await expect(h.result).resolves.toMatchObject({ kind: 'signed-in' });
  });

  it('4. raises the two-step code dialog, answers it, and ignores its echo', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Two-step login code:');
    await flush();
    expect(h.askCode).toHaveBeenCalledTimes(1);
    expect(h.askCode).toHaveBeenCalledWith('two-step');
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`, `${CODE}\n`]);
    h.child.exit(0, `${KEY}\n`);

    await expect(h.result).resolves.toMatchObject({ kind: 'signed-in' });
    expect(h.events).toContainEqual({ answered: 'two-step' });
  });

  it('5. raises the code dialog as new-device for the new-device prompt', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('New device verification required. Enter OTP sent to login email:');
    await flush();
    expect(h.askCode).toHaveBeenCalledWith('new-device');
    h.child.exit(0, `${KEY}\n`);
    await expect(h.result).resolves.toMatchObject({ kind: 'signed-in' });
  });
});

describe('what it will not answer', () => {
  it('6. stops at the two-step METHOD list, which only arrow keys can answer', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Two-step login method: (Use arrow keys)');

    await expect(h.result).resolves.toEqual({ kind: 'unsupported-step' });
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
    expect(h.child.stdinEnded).toBe(true);
  });

  it('7. stops AT ONCE on a prompt it does not know — not by timing out', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Something new:');
    // No timer has been advanced at all: only an immediate stop can settle.
    expect(await h.settledYet()).toBe(true);
    await expect(h.result).resolves.toEqual({ kind: 'unsupported-step' });
  });

  it('8. never answers a prompt twice: a real re-ask ends the sign-in', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    // Password answered in between, so this is not an echo: bw is asking again.
    h.child.prompt('Email address:');

    await expect(h.result).resolves.toEqual({ kind: 'failed' });
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
  });

  it('9. reports a cancelled code dialog as cancelled, and writes nothing more', async () => {
    const h = drive({ askCode: vi.fn(async () => null) });
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Two-step login code:');

    await expect(h.result).resolves.toEqual({ kind: 'cancelled' });
    expect(h.child.writes).toHaveLength(2);
  });
});

describe('time', () => {
  it('10. stops a silent bw at 60s after the last write — not at 59s', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    // Password written; now bw says nothing and does not exit (the SSO shape).
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(await h.settledYet()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(h.result).resolves.toEqual({ kind: 'quiet' });
  });

  it('10. does not run the quiet timer while a code dialog is open', async () => {
    let answer: (code: string | null) => void = () => {};
    const h = drive({ askCode: vi.fn(() => new Promise<string | null>((r) => (answer = r))) });
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Two-step login code:');
    await flush();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(await h.settledYet()).toBe(false);
    answer(CODE);
    await flush();
    h.child.exit(0, `${KEY}\n`);
    await expect(h.result).resolves.toMatchObject({ kind: 'signed-in' });
  });

  it('11. times out at the deadline, and a dialog answering afterwards writes nothing', async () => {
    let answer: (code: string | null) => void = () => {};
    const h = drive({ askCode: vi.fn(() => new Promise<string | null>((r) => (answer = r))) });
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.prompt('Two-step login code:');
    await flush();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await expect(h.result).resolves.toEqual({ kind: 'timed-out' });

    const writesAtDeadline = h.child.writes.length;
    answer(CODE); // the user finally types it
    await flush();
    expect(h.child.writes).toHaveLength(writesAtDeadline);
  });
});

describe('how it ends', () => {
  async function exitWith(stderr: string, code: number, stdout = ''): Promise<DriverResult> {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    h.child.err(stderr);
    h.child.exit(code, stdout);
    return h.result;
  }

  it('12. classifies each ending into a fixed category', async () => {
    expect(
      await exitWith(
        'Invalid master password. Confirm your email is correct and your account was created on vault.bitwarden.com.',
        1,
      ),
    ).toEqual({ kind: 'rejected' });
    expect(await exitWith('Invalid verification code.', 1)).toEqual({ kind: 'code-rejected' });
    expect(await exitWith(`You are already logged in as ${EMAIL}.`, 1)).toEqual({ kind: 'already-signed-in' });
    expect(await exitWith('', 0, '')).toEqual({ kind: 'failed' });
    expect(await exitWith('', 0, 'two tokens\n')).toEqual({ kind: 'failed' });
  });

  it('12. is not steered by an echoed email that contains a telling word', async () => {
    const h = drive({ credentials: { email: 'x@example.invalid', password: PASSWORD } });
    h.child.prompt('Email address:');
    await flush();
    h.child.echo('Email address:', 'x@example.invalid');
    h.child.err('something about verification went wrong');
    h.child.exit(1);
    await expect(h.result).resolves.toEqual({ kind: 'failed' });
  });
});

describe('what reaches the child', () => {
  it('13. runs exactly `login --raw`, with no user value in the command or any argument', async () => {
    const h = drive();
    h.child.prompt('Email address:');
    await flush();
    h.child.exit(1);
    await h.result;

    const [command, args] = h.spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args).toEqual(['/d', '/s', '/c', BW_CMD, 'login', '--raw']);
    for (const part of [command, ...args]) {
      expect(part).not.toContain(EMAIL);
      expect(part).not.toContain(PASSWORD);
    }
  });

  it('14. strips every output-shaping variable in any casing, and passes no secret', async () => {
    const ambient = {
      PATH: 'C:\\tools',
      KEEP_ME: 'yes',
      BW_SESSION: 'stale-key',
      Bw_NoInteraction: 'true',
      BW_QUIET: 'true',
      BW_RESPONSE: 'true',
      BW_CLEANEXIT: 'true',
      bw_pretty: 'true',
      BW_RAW: 'true',
    };
    const h = drive({ environment: ambient });
    h.child.prompt('Email address:');
    await flush();
    h.child.exit(1);
    await h.result;

    const env = h.spawn.mock.calls[0]![2] as NodeJS.ProcessEnv;
    const upper = Object.keys(env).map((k) => k.toUpperCase());
    for (const name of ['BW_SESSION', 'BW_NOINTERACTION', 'BW_QUIET', 'BW_RESPONSE', 'BW_CLEANEXIT', 'BW_PRETTY', 'BW_RAW']) {
      expect(upper).not.toContain(name);
    }
    expect(env['KEEP_ME']).toBe('yes');
    expect(Object.values(env)).not.toContain(PASSWORD);
    expect(Object.values(env)).not.toContain(EMAIL);
    expect(loginEnv(ambient)).toEqual(env);
  });

  it('15. never lets stderr out: a canary printed by bw is in no result or event', async () => {
    const CANARY = 'CANARY-7f3e-do-not-leak';
    const h = drive();
    h.child.prompt('Email address:');
    await flush();
    h.child.err(`Something failed near ${CANARY}\n`);
    h.child.exit(1, `${CANARY}\n`);
    const result = await h.result;

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(h.events)).not.toContain(CANARY);
  });
});

describe('stopping bw — story §4.4', () => {
  it('16. a stop ends stdin, kills the recorded bw PID, and kills what we spawned', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await expect(h.result).resolves.toEqual({ kind: 'quiet' });

    expect(h.child.stdinEnded).toBe(true);
    expect(h.killPid).toHaveBeenCalledWith(4242);
    expect(h.child.kills).toBe(1);
  });

  it('16. never kills the recorded PID once what we spawned has exited', async () => {
    const h = drive();
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    // The wrapper is gone, so 4242 may already be someone else's PID.
    h.child.emit('error', new Error('spawned process died'));
    await expect(h.result).resolves.toEqual({ kind: 'failed' });
    expect(h.killPid).not.toHaveBeenCalled();
  });

  it('17. with no PID for bw, stops at the email prompt having written NOTHING', async () => {
    for (const lookup of [
      vi.fn(async () => null),
      vi.fn(async () => {
        throw new Error('CIM blocked');
      }),
    ]) {
      const h = drive({ findBwProcess: lookup });
      h.child.prompt('Email address:');
      await expect(h.result).resolves.toEqual({ kind: 'failed' });
      expect(h.child.writes).toEqual([]);
      expect(h.child.stdinEnded).toBe(true);
    }
  });

  it('17. a lookup that never answers writes nothing, and ends at the deadline', async () => {
    const h = drive({ findBwProcess: vi.fn(() => new Promise<number>(() => {})) });
    h.child.prompt('Email address:');
    await flush();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await expect(h.result).resolves.toEqual({ kind: 'timed-out' });
    expect(h.child.writes).toEqual([]);
  });

  it('18. a standalone bw.exe with no child IS bw; a shim .exe records its child', async () => {
    const standalone = drive({ binary: 'C:\\tools\\bw.exe', findBwProcess: vi.fn(async () => 'self' as const) });
    standalone.child.prompt('Email address:');
    await flush();
    expect(standalone.child.writes).toEqual([`${EMAIL}\n`]);
    standalone.child.exit(1);
    await standalone.result;
    expect(standalone.spawn.mock.calls[0]![0]).toBe('C:\\tools\\bw.exe');

    const shim = drive({ binary: 'C:\\scoop\\shims\\bw.exe', findBwProcess: vi.fn(async () => 77) });
    scriptEchoingBw(shim.child);
    shim.child.prompt('Email address:');
    await flush();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await shim.result;
    expect(shim.killPid).toHaveBeenCalledWith(77);
  });

  it('18. a cmd.exe wrapper with no child under it is NOT bw', async () => {
    const h = drive({ findBwProcess: vi.fn(async () => 'self' as const) });
    h.child.prompt('Email address:');
    await expect(h.result).resolves.toEqual({ kind: 'failed' });
    expect(h.child.writes).toEqual([]);
  });

  it('18. off Windows there is no lookup, and a stop kills the child directly', async () => {
    const h = drive({ binary: '/usr/local/bin/bw', platform: 'linux' });
    scriptEchoingBw(h.child);
    h.child.prompt('Email address:');
    await flush();
    expect(h.child.writes).toEqual([`${EMAIL}\n`, `${PASSWORD}\n`]);
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    await expect(h.result).resolves.toEqual({ kind: 'quiet' });
    expect(h.findBwProcess).not.toHaveBeenCalled();
    expect(h.killPid).not.toHaveBeenCalled();
    expect(h.child.kills).toBe(1);
    expect(h.spawn.mock.calls[0]![1]).toEqual(['login', '--raw']);
  });
});

describe('values that could answer two prompts', () => {
  it('refuses a value containing a line break before spawning anything', async () => {
    const h = drive({ credentials: { email: EMAIL, password: `half\n${PASSWORD}` } });
    await expect(h.result).resolves.toEqual({ kind: 'failed' });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
