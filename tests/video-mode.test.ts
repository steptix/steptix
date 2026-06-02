/**
 * Pure-function tests for the video-mode helpers in src/browser/manager.ts:
 *  - `resolveVideoMode`: tri-state string + boolean sugar → canonical VideoMode
 *  - `incompatibleCdpConfig`: lists `video=<mode>` among the config values CDP
 *    mode ignores (so the user isn't left wondering why recording did nothing)
 *
 * No browser is launched — these mirror the parseCdpTabSpec unit tests in
 * browser-manager-cdp.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { resolveVideoMode, incompatibleCdpConfig } from '../src/browser/manager.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { BrowserConfig } from '../src/config/types.js';

describe('resolveVideoMode', () => {
  it('maps boolean true → on, false → off', () => {
    expect(resolveVideoMode(true)).toBe('on');
    expect(resolveVideoMode(false)).toBe('off');
  });

  it('maps undefined → off (defends synthesized configs that skip defaults)', () => {
    expect(resolveVideoMode(undefined)).toBe('off');
  });

  it('passes the three canonical strings through unchanged', () => {
    expect(resolveVideoMode('off')).toBe('off');
    expect(resolveVideoMode('on')).toBe('on');
    expect(resolveVideoMode('retain-on-failure')).toBe('retain-on-failure');
  });

  it('falls back to off on an unrecognised value (typo in a hand-edited config)', () => {
    // Values the TS type forbids but a hand-edited aiui.config.json could carry
    // (the loader does no per-field validation). Must fail safe to 'off' rather
    // than record-and-keep — a typo'd "retain-on-faliure" must NOT behave like 'on'.
    const bad = (v: string) => resolveVideoMode(v as unknown as BrowserConfig['video']);
    expect(bad('always')).toBe('off');
    expect(bad('retain-on-faliure')).toBe('off');
    expect(bad('')).toBe('off');
  });
});

describe('incompatibleCdpConfig', () => {
  /** A clean BrowserConfig (video off, nothing else CDP-incompatible). */
  function baseConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
    return {
      ...structuredClone(DEFAULT_CONFIG.browser),
      // DEFAULT headed is true; leave it so headless isn't flagged by default.
      stealth: false,
      slowMo: 0,
      video: 'off',
      ...overrides,
    };
  }

  it('lists nothing for a clean config', () => {
    expect(incompatibleCdpConfig(baseConfig())).toEqual([]);
  });

  it('lists video=<mode> when video recording is enabled', () => {
    expect(incompatibleCdpConfig(baseConfig({ video: 'on' }))).toContain('video=on');
    expect(incompatibleCdpConfig(baseConfig({ video: 'retain-on-failure' })))
      .toContain('video=retain-on-failure');
    // Boolean sugar normalises before listing.
    expect(incompatibleCdpConfig(baseConfig({ video: true }))).toContain('video=on');
  });

  it('omits video when off / false', () => {
    expect(incompatibleCdpConfig(baseConfig({ video: 'off' }))).not.toContain('video=off');
    expect(incompatibleCdpConfig(baseConfig({ video: false }))).not.toContain('video=off');
  });

  it('still lists the other ignored values alongside video', () => {
    const ignored = incompatibleCdpConfig(baseConfig({ headed: false, video: 'on' }));
    expect(ignored).toContain('headed=false (headless)');
    expect(ignored).toContain('video=on');
  });
});
