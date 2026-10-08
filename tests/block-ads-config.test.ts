/**
 * `browser.blockAds` holds the project's own list of domains to block
 * (docs/specs/SPEC-web-survey-fixes.md §2.51). The framework has no list, so
 * the loader refuses anything but a list of bare host names, and the Chromium
 * switch can only ever hold `MAP <host> ~NOTFOUND` rules.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { loadConfig } from '../src/config/loader.js';
import { hostResolverRule, isBlockableHost, isBlockedHost } from '../src/config/block-hosts.js';

const dirs: string[] = [];

function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'steptix-block-ads-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'steptix.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('loading browser.blockAds', () => {
  it('keeps the project\'s list as written', async () => {
    const config = await loadConfig(undefined, projectWith({ browser: { blockAds: ['ads.example', 'tracker.example'] } }));
    expect(config.browser.blockAds).toEqual(['ads.example', 'tracker.example']);
  });

  it('blocks nothing when the project says nothing', async () => {
    const config = await loadConfig(undefined, projectWith({}));
    expect(config.browser.blockAds ?? []).toEqual([]);
  });

  it('refuses true, which used to mean a built-in list, and shows the form to write', async () => {
    await expect(loadConfig(undefined, projectWith({ browser: { blockAds: true } })))
      .rejects.toThrow(/Invalid browser\.blockAds .*expected a list of domains, got the boolean true\. Steptix has no built-in list/);
  });

  it('refuses entries that are not bare host names, naming each', async () => {
    const dir = projectWith({ browser: { blockAds: ['ads.example', 'https://tracker.example/x', 'a.example, MAP * 127.0.0.1', 7] } });
    const err = await loadConfig(undefined, dir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('"https://tracker.example/x"');
    expect(message).toContain('"a.example, MAP * 127.0.0.1"');
    expect(message).toContain('the number 7');
    expect(message).not.toContain('"ads.example"');
    expect(message).toMatch(/are not domains\. Write each as a bare host name/);
  });

  it('is described as a list of strings in the generated schema', () => {
    const schemaPath = fileURLToPath(new URL('../schema/steptix.config.schema.json', import.meta.url));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    expect(validate({ browser: { blockAds: ['ads.example'] } })).toBe(true);
    expect(validate({ browser: { blockAds: true } })).toBe(false);
  });
});

describe('matching blocked hosts', () => {
  const hosts = ['ads.example', 'Tracker.Example'];

  it('blocks a listed host and its subdomains, in any case', () => {
    expect(isBlockedHost('https://ads.example/x.js', hosts)).toBe(true);
    expect(isBlockedHost('https://cdn.ads.example/x.js', hosts)).toBe(true);
    expect(isBlockedHost('https://TRACKER.example/p', hosts)).toBe(true);
  });

  it('does not block look-alikes, query strings or anything unlisted', () => {
    expect(isBlockedHost('https://notads.example/', hosts)).toBe(false);
    expect(isBlockedHost('https://ads.example.other.test/', hosts)).toBe(false);
    expect(isBlockedHost('https://shop.example/?ref=ads.example', hosts)).toBe(false);
    expect(isBlockedHost('not a url', hosts)).toBe(false);
    expect(isBlockedHost('https://ads.example/', [])).toBe(false);
  });

  it('writes one host-resolver rule per host and subdomain, and leaves out anything else', () => {
    expect(hostResolverRule(['ads.example', 'x.test, MAP * 127.0.0.1']))
      .toBe('--host-resolver-rules=MAP ads.example ~NOTFOUND, MAP *.ads.example ~NOTFOUND');
  });

  it('accepts host names only', () => {
    expect(isBlockableHost('ads.example')).toBe(true);
    expect(isBlockableHost('localhost')).toBe(true);
    for (const bad of ['', '.ads.example', '*.ads.example', 'ads.example/', 'https://ads.example', 'a b.example', '-ads.example', 7]) {
      expect(isBlockableHost(bad)).toBe(false);
    }
  });
});
