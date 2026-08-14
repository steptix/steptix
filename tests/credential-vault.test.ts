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
import { BitwardenVault } from '../src/credentials/vault.js';
import { VaultError } from '../src/credentials/types.js';

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
