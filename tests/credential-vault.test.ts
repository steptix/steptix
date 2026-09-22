// The vault adapter's two hardening rules.
//
// Both exist because of the same fact: on Windows the Bitwarden CLI installed
// by npm is `bw.cmd`, which Node will not spawn without a shell, so the real
// launch path runs through `cmd.exe` — where `&`, `|`, `^` and `%` are syntax.
// The page-supplied string that reaches that command line is therefore an
// injection site unless something narrows it first. Two things do:
//
//   `originForLookup`  — the only page-derived value that may be passed, cut
//                        down to scheme + host + port and pattern-checked.
//   `SAFE_ARG`         — a refusal, in `runBw`, for anything that slipped past.

import { describe, expect, it } from 'vitest';
import { originForLookup } from '../src/credentials/domain-match.js';
import { BitwardenVault, bwLaunch, type BwRunner } from '../src/credentials/vault.js';
import { VaultError } from '../src/credentials/types.js';

/** One login item, in the shape `bw list items` emits. */
function bwItem(name: string, uri: string) {
  return {
    object: 'item',
    id: `id-${name}`,
    name,
    type: 1,
    login: { uris: [{ match: null, uri }], username: 'u', password: 'p', totp: null },
  };
}

/**
 * A fake `bw` whose contents can CHANGE between calls — which is the whole
 * point. The real defect was a cache that never refreshed, so a test against a
 * vault that never changes could not have caught it, however thorough.
 */
function fakeBw(opts: { itemsAfterSyncs?: number } = {}) {
  const calls: string[] = [];
  let syncs = 0;
  const appearsAfter = opts.itemsAfterSyncs ?? 0;
  const runner: BwRunner = async (_binary, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'sync') {
      syncs += 1;
      return { code: 0, stdout: 'Syncing complete.', stderr: '' };
    }
    if (args[0] === 'list') {
      const visible = syncs >= appearsAfter ? [bwItem('SecureBank', 'https://www.example.com')] : [];
      return { code: 0, stdout: JSON.stringify(visible), stderr: '' };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  };
  return {
    runner,
    syncCount: () => calls.filter((c) => c === 'sync').length,
    listCount: () => calls.filter((c) => c.startsWith('list')).length,
  };
}

describe('keeping the local vault cache fresh', () => {
  it('finds an item that only becomes visible after a re-sync', async () => {
    // The reported bug, exactly: the item IS in Bitwarden, the server's cache
    // predates it, and the user is told "no saved login for this site" for a
    // credential they can see on screen.
    const bw = fakeBw({ itemsAfterSyncs: 2 });
    const vault = new BitwardenVault({ binary: 'bw', session: 'stub', environment: {}, runner: bw.runner });

    const items = await vault.itemsForUrl('https://www.example.com/login');

    expect(items.map((i) => i.name)).toEqual(['SecureBank']);
    // One sync on the way in, a second forced by the empty result.
    expect(bw.syncCount()).toBe(2);
    expect(bw.listCount()).toBe(2);
  });

  it('does not re-sync for a lookup that already found something', async () => {
    const bw = fakeBw();
    const vault = new BitwardenVault({ binary: 'bw', session: 'stub', environment: {}, runner: bw.runner });

    await vault.itemsForUrl('https://www.example.com/login');

    // The retry is paid on the way to a refusal, never on a hit.
    expect(bw.syncCount()).toBe(1);
    expect(bw.listCount()).toBe(1);
  });

  it('re-syncs once the cache has aged past its TTL', async () => {
    // A password rotated on another device is the dangerous half of staleness:
    // the old one still types, and the site rejects a login that looks correct
    // from here.
    const bw = fakeBw();
    let clock = 1_000_000;
    const vault = new BitwardenVault({
      binary: 'bw',
      session: 'stub',
      environment: {},
      runner: bw.runner,
      now: () => clock,
    });

    await vault.itemsForUrl('https://www.example.com/login');
    expect(bw.syncCount()).toBe(1);

    clock += 5_000;
    await vault.itemsForUrl('https://www.example.com/login');
    expect(bw.syncCount(), 'within the TTL, no extra sync').toBe(1);

    clock += 120_000;
    await vault.itemsForUrl('https://www.example.com/login');
    expect(bw.syncCount(), 'past the TTL, one more').toBe(2);
  });

  it('still answers when sync itself fails', async () => {
    // A sync that cannot reach the network leaves a stale cache, not a broken
    // vault — and refusing a login the cache can satisfy is the worse of the
    // two outcomes.
    const failing: BwRunner = async (_b, args) => {
      if (args[0] === 'sync') throw new Error('offline');
      return { code: 0, stdout: JSON.stringify([bwItem('SecureBank', 'https://www.example.com')]), stderr: '' };
    };
    const vault = new BitwardenVault({ binary: 'bw', session: 'stub', environment: {}, runner: failing });

    const items = await vault.itemsForUrl('https://www.example.com/login');
    expect(items.map((i) => i.name)).toEqual(['SecureBank']);
  });
});

describe('originForLookup — what may cross to the CLI', () => {
  it('reduces a full url to its origin', () => {
    expect(originForLookup('https://www.facebook.com/login?next=%2Ffeed#top')).toBe('https://www.facebook.com');
  });

  it('keeps a non-default port, which is part of the identity', () => {
    expect(originForLookup('http://127.0.0.1:8787/login')).toBe('http://127.0.0.1:8787');
  });

  it('drops a query string carrying cmd.exe metacharacters', () => {
    // The reason the origin is used at all. Passing this URL whole to a
    // `cmd.exe`-launched child is a command separator sitting in an argument.
    const origin = originForLookup('https://evil.example/login?a=1&calc&b=2');
    expect(origin).toBe('https://evil.example');
    expect(origin).not.toContain('&');
  });

  it('refuses a hostname containing anything but hostname characters', () => {
    // URL parsing normally rejects these before we do; the pattern is the
    // backstop for whatever a future WHATWG-parser change decides to allow.
    expect(originForLookup('https://ok.example')).toBe('https://ok.example');
    expect(originForLookup('http://exa mple.com/')).toBeNull();
  });

  it('refuses anything that is not http(s)', () => {
    expect(originForLookup('file:///c:/tmp/x.html')).toBeNull();
    expect(originForLookup('data:text/html,<input type=password>')).toBeNull();
    expect(originForLookup('about:blank')).toBeNull();
    expect(originForLookup('not a url at all')).toBeNull();
  });

  it('never emits a space, quote or shell metacharacter', () => {
    const samples = [
      'https://a.example/x?q=hello world',
      'https://b.example/x?q=%22quoted%22',
      'https://c.example/#^%&|<>',
    ];
    for (const sample of samples) {
      const origin = originForLookup(sample);
      expect(origin).not.toBeNull();
      expect(origin!).toMatch(/^https?:\/\/[a-z0-9.\-[\]]+(:\d+)?$/);
    }
  });
});

describe('runBw refuses an unexpected argument', () => {
  it('will not look up an item id that is not id-shaped', async () => {
    // `SAFE_ARG` in front of the spawn. Reached through the public method
    // rather than by exporting the regex, so the test fails if the check is
    // moved somewhere that no longer covers this path.
    const vault = new BitwardenVault({
      binary: 'C:/nonexistent/bw.cmd',
      session: 'stub',
      environment: { PATH: '' },
    });

    await expect(vault.secretFor('id & calc')).rejects.toThrow(VaultError);
    await expect(vault.secretFor('id & calc')).rejects.toThrow(/unexpected argument/i);
  });

  it('accepts an ordinary vault item id', async () => {
    // The refusal must be specific to unsafe input, not a blanket "no". This
    // one gets past the gate and fails later, on the missing binary — a
    // different error, which is the point.
    const vault = new BitwardenVault({
      binary: 'C:/nonexistent/bw-does-not-exist',
      session: 'stub',
      environment: { PATH: '' },
    });

    await expect(vault.secretFor('9f1c2b3a-0000-4444-8888-abcdefabcdef')).rejects.toThrow(
      /not installed|ENOENT|spawn/i,
    );
  });
});

// ---------------------------------------------------------------------------
// A key for a signed-out CLI (stories/bitwarden-sign-in.md §2.3, test 30)
// ---------------------------------------------------------------------------

describe('dropping a dead session key', () => {
  const NOT_LOGGED_IN = { code: 1, stdout: '', stderr: 'You are not logged in.' };

  it('30. forgets the key when bw says nobody is signed in', async () => {
    const runner: BwRunner = async (_b, args) =>
      args[0] === 'sync' ? { code: 0, stdout: '', stderr: '' } : NOT_LOGGED_IN;
    const vault = new BitwardenVault({ runner, session: 'key-A', environment: {} });

    await expect(vault.itemsForUrl('https://www.example.com/login')).rejects.toMatchObject({
      kind: 'not-logged-in',
    });
    expect(vault.unlocked).toBe(false);
  });

  it('30. keeps a NEWER key adopted while the failing call was in flight', async () => {
    // The race §2.3 exists for: a lookup started with a stale key, a sign-in
    // stored a fresh one, and then the stale lookup came back "not logged in".
    const seen: Array<string | undefined> = [];
    let vault!: BitwardenVault;
    let first = true;
    const runner: BwRunner = async (_b, args, env) => {
      if (args[0] === 'sync') return { code: 0, stdout: '', stderr: '' };
      seen.push(env['BW_SESSION']);
      if (first) {
        first = false;
        vault.adoptSession('key-B'); // the concurrent sign-in lands mid-call
        return NOT_LOGGED_IN;
      }
      return { code: 0, stdout: '[]', stderr: '' };
    };
    vault = new BitwardenVault({ runner, session: 'key-A', environment: {} });

    await expect(vault.itemsForUrl('https://www.example.com/login')).rejects.toMatchObject({
      kind: 'not-logged-in',
    });
    expect(vault.unlocked).toBe(true);
    await vault.itemsForUrl('https://www.example.com/login');
    expect(seen).toEqual(['key-A', 'key-B', 'key-B']); // the retry-after-sync ran on B too
  });

  it('30. drops the key on the secret fetch too, not only the lookup', async () => {
    const runner: BwRunner = async () => NOT_LOGGED_IN;
    const vault = new BitwardenVault({ runner, session: 'key-A', environment: {} });
    await expect(vault.secretFor('id-1')).rejects.toBeInstanceOf(VaultError);
    expect(vault.unlocked).toBe(false);
  });

  it('keeps the key for a failure that is not "not logged in"', async () => {
    const runner: BwRunner = async (_b, args) =>
      args[0] === 'sync' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Something else.' };
    const vault = new BitwardenVault({ runner, session: 'key-A', environment: {} });
    await expect(vault.itemsForUrl('https://www.example.com/login')).rejects.toMatchObject({ kind: 'unreadable' });
    expect(vault.unlocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The one launch rule (story §4.1, test 31)
// ---------------------------------------------------------------------------

describe('bwLaunch', () => {
  // String.raw throughout: in a plain string literal `'C:\npm\bw.cmd'` holds a
  // NEWLINE, and a test comparing two equally-mangled paths proves nothing.
  const COMSPEC = String.raw`C:\Windows\System32\cmd.exe`;
  const env = { COMSPEC };

  it('31. wraps a .cmd or .bat as cmd.exe /d /s /c ""<binary>" <args>", verbatim, honouring COMSPEC', () => {
    expect(bwLaunch(String.raw`C:\npm\bw.cmd`, ['status', '--raw'], env, 'win32')).toEqual({
      command: COMSPEC,
      args: ['/d', '/v:off', '/s', '/c', String.raw`""C:\npm\bw.cmd" status --raw"`],
      verbatim: true,
    });
    expect(bwLaunch(String.raw`C:\npm\BW.BAT`, ['sync'], {}, 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', String.raw`""C:\npm\BW.BAT" sync"`],
      verbatim: true,
    });
  });

  it('31. keeps a path with a SPACE in it whole — the default npm-global location', () => {
    // %APPDATA%\npm under a profile like "C:\Users\First Last". With Node's own
    // quoting plus /s, cmd.exe stripped the quotes and split the path here.
    const spaced = String.raw`C:\Users\First Last\AppData\Roaming\npm\bw.cmd`;
    expect(bwLaunch(spaced, ['login', '--raw'], env, 'win32').args[4]).toBe(`""${spaced}" login --raw"`);
  });

  it('31. refuses an argument that would stand unquoted in front of cmd.exe', () => {
    // After /s strips the outer quotes the arguments are outside any quotes,
    // where cmd.exe acts on & | < > ^ %. bwLaunch checks — not its callers.
    for (const bad of ['a&b', 'x|y', '%PATH%', 'two words']) {
      expect(() => bwLaunch(String.raw`C:\npm\bw.cmd`, ['list', bad], env, 'win32'), bad).toThrow(VaultError);
    }
  });

  it('31. refuses a binary path cmd.exe would interpret even inside quotes', () => {
    for (const bad of [String.raw`C:\a%PATH%b\bw.cmd`, String.raw`C:\a"b\bw.cmd`, 'C:\\a\nb\\bw.cmd']) {
      expect(() => bwLaunch(bad, ['sync'], env, 'win32'), JSON.stringify(bad)).toThrow(VaultError);
    }
  });

  it('31. runs an .exe directly, and wraps nothing off Windows', () => {
    expect(bwLaunch(String.raw`C:\tools\bw.exe`, ['login', '--raw'], env, 'win32')).toEqual({
      command: String.raw`C:\tools\bw.exe`,
      args: ['login', '--raw'],
      verbatim: false,
    });
    expect(bwLaunch('/opt/bw/bw.cmd', ['sync'], env, 'linux')).toEqual({
      command: '/opt/bw/bw.cmd',
      args: ['sync'],
      verbatim: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Which calls may prompt: BW_NOINTERACTION
// ---------------------------------------------------------------------------
//
// `bw` reads `BW_NOINTERACTION` (every check is `!== "true"`); the vault used to
// set `BITWARDENCLI_NOINTERACTION`, which `bw` never reads, so the guard was a
// no-op — and unlock only worked because it was, since unlock hands the master
// password to bw's interactive prompt. These pin the split: every call that
// must not prompt says so, unlock is the one call that must be able to.

describe('BW_NOINTERACTION: which calls may prompt', () => {
  interface Call {
    args: string[];
    env: NodeJS.ProcessEnv;
    input: string | undefined;
  }

  /** A fake bw that answers every call the vault makes, and records each one. */
  function recordingBw() {
    const calls: Call[] = [];
    const runner: BwRunner = async (_binary, args, env, input) => {
      calls.push({ args, env, input });
      switch (args[0]) {
        case 'status':
          return { code: 0, stdout: '{"status":"unlocked"}', stderr: '' };
        case 'unlock':
          return { code: 0, stdout: 'fresh-session-key\n', stderr: '' };
        case 'list':
          return { code: 0, stdout: JSON.stringify([bwItem('SecureBank', 'https://www.example.com')]), stderr: '' };
        case 'get':
          return args[1] === 'totp'
            ? { code: 0, stdout: '123456', stderr: '' }
            : { code: 0, stdout: JSON.stringify({ login: { username: 'u', password: 'p' } }), stderr: '' };
        default:
          return { code: 0, stdout: '', stderr: '' };
      }
    };
    return { calls, runner };
  }

  /** Every key that is some casing of BW_NOINTERACTION. */
  function noInteractionKeys(env: NodeJS.ProcessEnv): string[] {
    return Object.keys(env).filter((k) => k.toUpperCase() === 'BW_NOINTERACTION');
  }

  it('sets BW_NOINTERACTION=true — in exactly one casing — on every call that must not prompt', async () => {
    const bw = recordingBw();
    // The user's own environment carries it in another casing, set to "false":
    // neither may survive, or bw could still stop at a prompt nobody answers.
    const vault = new BitwardenVault({
      runner: bw.runner,
      session: 'key-A',
      environment: { KEEP_ME: 'yes', Bw_NoInteraction: 'false' },
    });

    await vault.status();
    await vault.itemsForUrl('https://www.example.com/login'); // sync + list
    await vault.secretFor('id-SecureBank');
    await vault.totpFor('id-SecureBank');

    expect(bw.calls.map((c) => c.args[0])).toEqual(['status', 'sync', 'list', 'get', 'get']);
    for (const call of bw.calls) {
      expect(noInteractionKeys(call.env), call.args.join(' ')).toEqual(['BW_NOINTERACTION']);
      expect(call.env['BW_NOINTERACTION'], call.args.join(' ')).toBe('true');
      expect(call.env['KEEP_ME']).toBe('yes');
    }
  });

  it('REMOVES it for unlock, in any casing — even when the user set it themselves', async () => {
    // With BW_NOINTERACTION=true, `bw unlock` never draws its "Master password:"
    // prompt, so the password written to stdin is never read and bw refuses.
    const bw = recordingBw();
    const vault = new BitwardenVault({
      runner: bw.runner,
      environment: { KEEP_ME: 'yes', BW_NOINTERACTION: 'true', bw_nointeraction: 'true' },
    });

    await expect(vault.unlock('master-password')).resolves.toBe(true);

    const unlock = bw.calls.find((c) => c.args[0] === 'unlock');
    expect(unlock).toBeDefined(); // through the runner seam, like every other call
    expect(noInteractionKeys(unlock!.env)).toEqual([]);
    expect(unlock!.env['KEEP_ME']).toBe('yes');
    expect(unlock!.input).toBe('master-password\n');
    expect(unlock!.args).toEqual(['unlock', '--raw']);
    expect(vault.unlocked).toBe(true);
  });

  it('never sets the misnamed BITWARDENCLI_NOINTERACTION, on any call', async () => {
    const bw = recordingBw();
    const vault = new BitwardenVault({ runner: bw.runner, environment: {} });
    await vault.status();
    await vault.unlock('master-password');
    await vault.itemsForUrl('https://www.example.com/login');
    for (const call of bw.calls) {
      expect(Object.keys(call.env).some((k) => k.toUpperCase() === 'BITWARDENCLI_NOINTERACTION'), call.args[0]).toBe(
        false,
      );
    }
  });

  it("classifies bw's answer to a lookup on a locked vault, once prompts are off, as locked", async () => {
    // With BW_NOINTERACTION=true bw answers a locked lookup with exactly this
    // (bw.js BaseProgram.handleLockedUser); with it unset it would instead run
    // an inline unlock and draw a password prompt on a closed stdin.
    const runner: BwRunner = async (_b, args) =>
      args[0] === 'sync' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'Vault is locked.' };
    const vault = new BitwardenVault({ runner, session: 'key-A', environment: {} });
    await expect(vault.itemsForUrl('https://www.example.com/login')).rejects.toMatchObject({ kind: 'locked' });
  });
});
