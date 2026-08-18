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
import { BitwardenVault, type BwRunner } from '../src/credentials/vault.js';
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
