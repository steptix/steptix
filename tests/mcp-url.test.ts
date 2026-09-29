import { describe, it, expect } from 'vitest';
import { canonicalServerKey, isLoopbackHost, normalizeSpawnHost } from '../src/mcp/url.js';

// ---------------------------------------------------------------------------
// These three functions exist to make one question have one answer: "is this
// the same server?" Four places ask it — the session mutex, the "config
// already sent" flag, the auto-start single-flight and the auto-start backoff
// — and when they disagree the symptoms are indirect (a duplicate browser, a
// config rejected as a repeat) rather than an obvious wrong answer. So the
// interesting cases here are all spellings of one address.
// ---------------------------------------------------------------------------

describe('normalizeSpawnHost', () => {
  it('collapses localhost onto 127.0.0.1', () => {
    // Not cosmetic: `server.listen('localhost')` resolves through dns.lookup,
    // which prefers ::1 on a dual-stack Windows box. The child would bind IPv6
    // loopback only, and `steptix status` — which reads 127.0.0.1 from
    // steptix.config.json — would report "not running" against a live server.
    expect(normalizeSpawnHost('localhost')).toBe('127.0.0.1');
    expect(normalizeSpawnHost('LOCALHOST')).toBe('127.0.0.1');
    expect(normalizeSpawnHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('strips the brackets URL parsing leaves on IPv6 hosts', () => {
    // `new URL('http://[::1]:3100').hostname` keeps them, and listen() rejects
    // the bracketed form.
    expect(normalizeSpawnHost('[::1]')).toBe('::1');
    expect(normalizeSpawnHost('::1')).toBe('::1');
  });

  it('leaves anything else alone', () => {
    expect(normalizeSpawnHost('example.test')).toBe('example.test');
    expect(normalizeSpawnHost('0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('isLoopbackHost', () => {
  it('accepts the four spellings we auto-start on', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'LocalHost']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('rejects 0.0.0.0 and the rest of 127/8', () => {
    // 0.0.0.0 is a bind wildcard, not an address we can claim is "ours"; the
    // rest of 127/8 is loopback but nothing in this project ever uses it, and
    // widening the set widens what we will spawn a server on top of.
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
    expect(isLoopbackHost('example.test')).toBe(false);
  });
});

describe('canonicalServerKey', () => {
  it('files every spelling of loopback under one key', () => {
    const key = canonicalServerKey('http://127.0.0.1:3100');
    expect(canonicalServerKey('http://localhost:3100')).toBe(key);
    expect(canonicalServerKey('HTTP://LOCALHOST:3100')).toBe(key);
    expect(canonicalServerKey('http://localhost:3100/')).toBe(key);
  });

  it('keeps genuinely different servers apart', () => {
    expect(canonicalServerKey('http://localhost:3100')).not.toBe(
      canonicalServerKey('http://localhost:3200'),
    );
    expect(canonicalServerKey('http://localhost:3100')).not.toBe(
      canonicalServerKey('http://example.test:3100'),
    );
  });

  it('returns a stable key for an unparseable URL instead of throwing', () => {
    // Validation belongs to auto-start, which can name the bad value in an
    // error. Throwing here would turn a diagnosable config mistake into a
    // stack trace from a bookkeeping helper.
    expect(canonicalServerKey('not a url')).toBe(canonicalServerKey('not a url'));
  });
});
