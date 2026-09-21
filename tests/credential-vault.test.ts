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
      args: ['/d', '/s', '/c', String.raw`""C:\npm\bw.cmd" status --raw"`],
      verbatim: true,
    });
    expect(bwLaunch(String.raw`C:\npm\BW.BAT`, ['sync'], {}, 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', String.raw`""C:\npm\BW.BAT" sync"`],
      verbatim: true,
    });
  });

  it('31. keeps a path with a SPACE in it whole — the default npm-global location', () => {
    // %APPDATA%\npm under a profile like "C:\Users\First Last". With Node's own
    // quoting plus /s, cmd.exe stripped the quotes and split the path here.
    const spaced = String.raw`C:\Users\First Last\AppData\Roaming\npm\bw.cmd`;
    expect(bwLaunch(spaced, ['login', '--raw'], env, 'win32').args[3]).toBe(`""${spaced}" login --raw"`);
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
