// The login driver against real processes (stories/bitwarden-sign-in.md
// §10.3, tests 41–44). Windows only, and opt-in by nature: 41 and 44 need
// Windows, 42 and 43 need the Bitwarden CLI and are skipped without it.
//
// These exist because the driver's unit tests run against a fake child, and
// the two claims that matter most cannot be made against a fake:
//
//  41. that a `bw` in the SSO state — prompts closed, stdin ignored, holding a
//      listener — is really STOPPED. It survives both ending its stdin and
//      killing the cmd.exe we spawned (story §1 fact 10); only the recorded-PID
//      kill works, and only a real process table can show that it did.
//  42. that the real `bw`'s prompts, and its echo, are still what the driver
//      reads — the one thing a `bw` upgrade could silently break.
//  43. that a canary master password reaches no command line and no
//      environment, through the real spawn, without ever leaving the machine.
//
// Nothing here touches the user's own Bitwarden state: every `bw` run uses a
// throwaway BITWARDENCLI_APPDATA_DIR, and 43 points it at a closed local port.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { driveLogin, type DriverEvent, type LoginChild } from '../src/credentials/bw-login.js';
import { findBwProcess } from '../src/credentials/bw-process.js';
import { BitwardenVault, bwLaunch, resolveBinary, type BwLaunch } from '../src/credentials/vault.js';

const IS_WINDOWS = process.platform === 'win32';
const REAL_BW = IS_WINDOWS ? resolveBinary('bw', process.env) : 'bw';
const HAS_BW = IS_WINDOWS && /\.(exe|cmd|bat)$/i.test(REAL_BW) && existsSync(REAL_BW);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** PIDs a test found alive and must not leave behind, whatever it asserted. */
const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    if (alive(pid)) process.kill(pid);
  }
});

/**
 * Can this machine answer "which child is bw?" at all? Asked of a wrapper this
 * test spawns itself, so a machine with CIM blocked skips test 41 with that
 * reason instead of failing it: 41 proves the stop, not the lookup.
 */
async function lookupWorks(dir: string): Promise<boolean> {
  const waiter = path.join(dir, 'wait.cjs');
  writeFileSync(waiter, 'setTimeout(function () {}, 15000);\n');
  const wrapper = spawn(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', process.execPath, waiter], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const pick = await findBwProcess(wrapper.pid!);
    if (typeof pick === 'number') process.kill(pick);
    return typeof pick === 'number';
  } finally {
    wrapper.kill();
  }
}

describe.runIf(IS_WINDOWS)('41. the SSO state is really stopped', () => {
  it('stops a bw that ignores stdin and outlives its wrapper — by its own PID', { timeout: 60_000 }, async (ctx) => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'bw-sso-stub-'));
    if (!(await lookupWorks(base))) ctx.skip();
    // A space in the path, as under a profile like "C:\Users\First Last": the
    // stub is launched through the same cmd.exe line a real npm-global bw is.
    const dir = path.join(base, 'with space');
    mkdirSync(dir);

    // The stub: two prompts in bw's shape, then the SSO state — readline
    // closed, a localhost listener, no timeout. It writes its own PID so the
    // test can check it without walking any process table. A 45s self-exit is
    // a leak guard only; the assertion below is made long before it.
    const pidFile = path.join(dir, 'stub.pid');
    const stub = path.join(dir, 'stub.cjs');
    writeFileSync(
      stub,
      `const fs = require('fs'), http = require('http'), readline = require('readline');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl = readline.createInterface({ input: process.stdin });
process.stderr.write('? Email address: ');
rl.once('line', () => {
  process.stderr.write('\\n? Master password: [input is hidden] ');
  rl.once('line', () => {
    rl.close();
    http.createServer(() => {}).listen(0, '127.0.0.1');
    setTimeout(() => process.exit(0), 45000);
  });
});
`,
    );
    const fakeBw = path.join(dir, 'fake-bw.cmd');
    writeFileSync(fakeBw, `@"${process.execPath}" "${stub}"\r\n`);

    const result = await driveLogin({
      binary: fakeBw,
      environment: process.env,
      credentials: { email: 'probe@example.invalid', password: 'stub-password' },
      askCode: async () => null,
      quietMs: 2_000,
      deadlineMs: 30_000,
    });

    const stubPid = Number(readFileSync(pidFile, 'utf8'));
    leftovers.push(stubPid);
    expect(result).toEqual({ kind: 'quiet' });
    // The stop is asynchronous at the OS level; give it a moment, not a guess.
    expect(await until(() => !alive(stubPid), 3_000)).toBe(true);
  });
});

describe.runIf(IS_WINDOWS)('a bw installed under a path with a space', () => {
  it('44. vault calls reach it: status() through a spaced .cmd path, for real', { timeout: 30_000 }, async () => {
    // What `bw status --raw` prints, from a .cmd under "with space\". Before
    // the launch fix, cmd.exe split this path at the space, the call failed,
    // and status() could not answer.
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'bw-spaced-')), 'with space');
    mkdirSync(dir);
    const fakeBw = path.join(dir, 'bw.cmd');
    writeFileSync(fakeBw, '@echo {"status":"unauthenticated"}\r\n');
    const vault = new BitwardenVault({ binary: fakeBw, environment: process.env });
    await expect(vault.status()).resolves.toBe('unauthenticated');
  });
});

/** A throwaway bw data folder, so the user's own sign-in state is never touched. */
function throwawayAppData(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'bw-appdata-'));
}

describe.runIf(HAS_BW)('against the real bw', () => {
  it('42. its prompts and echo are still what the driver reads (no network)', { timeout: 60_000 }, async () => {
    const events: DriverEvent[] = [];
    const result = await driveLogin({
      binary: REAL_BW,
      environment: { ...process.env, BITWARDENCLI_APPDATA_DIR: throwawayAppData() },
      // An EMPTY password is refused by bw locally — "Master password is
      // required." — so this run never reaches the network, and the refusal can
      // only happen if the password prompt read the driver's second answer.
      credentials: { email: 'probe@example.invalid', password: '' },
      askCode: async () => null,
      onEvent: (e) => events.push(e),
    });

    expect(result).toEqual({ kind: 'failed' });
    expect(events).toEqual([{ answered: 'email' }, { answered: 'password' }, { stopped: 'failed' }]);
  });

  it('43. a canary master password reaches no command line and no environment', { timeout: 60_000 }, async () => {
    const CANARY = 'canary-master-password-8c41e2';
    const appData = throwawayAppData();
    const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: appData };

    // Point this throwaway bw at a closed local port: its first request is
    // refused on this machine, so the canary cannot reach Bitwarden.
    const config = bwLaunch(REAL_BW, ['config', 'server', 'https://127.0.0.1:9'], env);
    const configured = spawnSync(config.command, config.args, {
      env,
      windowsHide: true,
      windowsVerbatimArguments: config.verbatim,
      stdio: 'ignore',
    });
    expect(configured.status).toBe(0);

    const spawned: Array<{ launch: BwLaunch; env: NodeJS.ProcessEnv }> = [];
    const events: DriverEvent[] = [];
    const result = await driveLogin({
      binary: REAL_BW,
      environment: env,
      credentials: { email: 'probe@example.invalid', password: CANARY },
      askCode: async () => null,
      onEvent: (e) => events.push(e),
      spawn: (launch, childEnv): LoginChild => {
        spawned.push({ launch, env: childEnv });
        return spawn(launch.command, launch.args, {
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: launch.verbatim,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcess as LoginChild;
      },
    });

    // The canary really was typed into bw's password prompt — through its echo,
    // one "[input is hidden]" redraw per character — and bw then failed on the
    // refused connection. Without this, a driver that stopped early (a failed
    // PID lookup, an echo misread as a re-ask) would also end "failed" and the
    // canary would never have been sent anywhere at all.
    expect(events).toEqual([{ answered: 'email' }, { answered: 'password' }, { stopped: 'failed' }]);
    expect(spawned).toHaveLength(1);
    const [{ launch, env: childEnv }] = spawned as [(typeof spawned)[number]];
    const { command, args } = launch;
    for (const part of [command, ...args]) expect(part).not.toContain(CANARY);
    for (const value of Object.values(childEnv)) expect(value ?? '').not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result).toEqual({ kind: 'failed' }); // the refused connection
  });
});
