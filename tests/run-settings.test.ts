/**
 * The pure half of stories/run-settings.md §2–§3: merging overrides and
 * resolving them into a config plus a provenance record.
 *
 * The route/seam behaviour is covered end-to-end in
 * api-server-run-settings.test.ts. This file exists for the cases that are
 * awkward to reach over HTTP — the `custom` capture cell a hand-written config
 * can produce, and the exact shape of the resolved `Config` — and because the
 * completeness guarantee is worth an assertion that does not depend on a
 * session, a browser or a route.
 */
import { describe, it, expect } from 'vitest';
import {
  CAPTURE_MODES,
  captureModeOf,
  mergeRunSettings,
  resolveRunSettings,
} from '../src/config/run-settings.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { Config, RunSettings } from '../src/config/types.js';

/** A server config with every one of the four values pinned, so a resolution
 *  that reached for a default instead of the base is visible. */
const server: Config = {
  ...DEFAULT_CONFIG,
  ai: { ...DEFAULT_CONFIG.ai, model: 'server/model', sendScreenshots: false },
  browser: {
    ...DEFAULT_CONFIG.browser,
    captureScreenshotsPerAction: false,
    fullPageScreenshots: false,
  },
  execution: { ...DEFAULT_CONFIG.execution, screenshotOnFailure: true },
};

function resolve(overrides: RunSettings, project: Config = server) {
  return resolveRunSettings(server, project, server.ai.model, overrides);
}

describe('mergeRunSettings', () => {
  it('merges per key rather than replacing the slice', () => {
    const first = mergeRunSettings({}, { capture: 'every-step' });
    const second = mergeRunSettings(first, { fullPage: true });

    expect(second).toEqual({ capture: 'every-step', fullPage: true });
  });

  it('leaves everything alone when nothing arrives', () => {
    const current = { capture: 'every-step' as const, model: 'x/y' };
    expect(mergeRunSettings(current, undefined)).toEqual(current);
  });

  it('deletes the key on a clearing value rather than storing the clear', () => {
    // Storing `null` would make "not overridden" and "overridden to nothing"
    // indistinguishable in the report `GET /config` hands back.
    const set = mergeRunSettings({}, { capture: 'every-step', model: 'x/y', fullPage: true });
    const cleared = mergeRunSettings(set, { capture: 'default', model: null, fullPage: null });

    expect(cleared).toEqual({});
    expect('capture' in cleared).toBe(false);
  });

  it('trims a model and treats whitespace as a clear', () => {
    expect(mergeRunSettings({}, { model: '  x/y  ' })).toEqual({ model: 'x/y' });
    expect(mergeRunSettings({ model: 'x/y' }, { model: '   ' })).toEqual({});
  });

  it('does not mutate what it was given', () => {
    const current: RunSettings = { capture: 'every-step' };
    mergeRunSettings(current, { capture: 'none' });
    expect(current).toEqual({ capture: 'every-step' });
  });
});

describe('captureModeOf', () => {
  it('names each meaningful cell', () => {
    expect(captureModeOf(true, true)).toBe('every-step');
    expect(captureModeOf(false, true)).toBe('on-failure');
    expect(captureModeOf(false, false)).toBe('none');
  });

  it('names the cell the tool enum cannot express', () => {
    // Per-action capture on, failure capture off. Nobody asks for it through the
    // enum, but a hand-written aiui.config.json can set it — and rounding it to
    // 'every-step' would tell the reader failures are photographed when they are
    // not.
    expect(captureModeOf(true, false)).toBe('custom');
  });

  it('is not among the values the tool accepts', () => {
    expect(CAPTURE_MODES).not.toContain('custom');
  });
});

describe('resolveRunSettings', () => {
  it('produces a COMPLETE config, changing only the four values it owns', () => {
    // The risk the story names: both executor call sites take the whole object,
    // so a partial merge would blank out settings nobody asked to change.
    const { config } = resolve({ capture: 'every-step', fullPage: true });

    expect(config.browser.captureScreenshotsPerAction).toBe(true);
    expect(config.execution.screenshotOnFailure).toBe(true);
    expect(config.browser.fullPageScreenshots).toBe(true);

    // Everything else is the server's, key for key.
    const { browser: _b, execution: _e, ai: _a, ...restOfResolved } = config;
    const { browser: _b2, execution: _e2, ai: _a2, ...restOfServer } = server;
    expect(restOfResolved).toEqual(restOfServer);
    expect(config.browser.viewport).toEqual(server.browser.viewport);
    expect(config.browser.slowMo).toBe(server.browser.slowMo);
    expect(config.execution.timeout).toBe(server.execution.timeout);
    expect(config.ai.maxInputTokens).toBe(server.ai.maxInputTokens);
  });

  it('does not mutate the server config', () => {
    resolve({ capture: 'every-step', sendScreenshots: true });

    expect(server.browser.captureScreenshotsPerAction).toBe(false);
    expect(server.ai.sendScreenshots).toBe(false);
  });

  it('reports the server as the source when nothing overrode anything', () => {
    const { effective } = resolve({});

    expect(effective).toEqual({
      model: 'server/model',
      capture: 'on-failure',
      fullPage: false,
      sendScreenshots: false,
      sources: {
        model: 'server',
        capture: 'server',
        fullPage: 'server',
        sendScreenshots: 'server',
      },
    });
  });

  it('reports a differing project value as project-sourced', () => {
    const project: Config = {
      ...server,
      browser: { ...server.browser, fullPageScreenshots: true },
      ai: { ...server.ai, sendScreenshots: true },
    };
    const { config, effective } = resolve({}, project);

    expect(config.browser.fullPageScreenshots).toBe(true);
    expect(config.ai.sendScreenshots).toBe(true);
    expect(effective.sources.fullPage).toBe('project');
    expect(effective.sources.sendScreenshots).toBe('project');
    // Untouched by the project, so still the server's.
    expect(effective.sources.capture).toBe('server');
  });

  it('lets a session override beat the project value', () => {
    const project: Config = {
      ...server,
      browser: { ...server.browser, fullPageScreenshots: true },
    };
    const { config, effective } = resolve({ fullPage: false }, project);

    expect(config.browser.fullPageScreenshots).toBe(false);
    expect(effective.sources.fullPage).toBe('session');
  });

  it('treats a model from .env as project-sourced and an override as session', () => {
    // This is why the model is its own field rather than an injected
    // env.AI_MODEL: merged into `env`, the two would be indistinguishable.
    const fromEnv = resolveRunSettings(server, server, 'dotenv/model', {});
    expect(fromEnv.effective.model).toBe('dotenv/model');
    expect(fromEnv.effective.sources.model).toBe('project');

    const overridden = resolveRunSettings(server, server, 'dotenv/model', {
      model: 'agent/model',
    });
    expect(overridden.effective.model).toBe('agent/model');
    expect(overridden.effective.sources.model).toBe('session');
  });

  it('treats an absent captureScreenshotsPerAction as on, matching the executor', () => {
    // step-executor.ts reads this as `!== false`, so writing the resolved value
    // back must not flip an undefined to off.
    const noFlag: Config = {
      ...server,
      browser: { ...server.browser, captureScreenshotsPerAction: undefined },
    };
    const { config, effective } = resolveRunSettings(noFlag, noFlag, noFlag.ai.model, {});

    expect(config.browser.captureScreenshotsPerAction).toBe(true);
    expect(effective.capture).toBe('every-step');
  });

  it('reports the custom cell a config can produce', () => {
    const odd: Config = {
      ...server,
      browser: { ...server.browser, captureScreenshotsPerAction: true },
      execution: { ...server.execution, screenshotOnFailure: false },
    };
    const { effective } = resolveRunSettings(odd, odd, odd.ai.model, {});

    expect(effective.capture).toBe('custom');
  });

  it('"default" resolves to the base rather than the last override', () => {
    // The merge is what actually clears it; this asserts the resolver treats a
    // `default` that reaches it as "no override" rather than as a value.
    const { config, effective } = resolve({ capture: 'default' });

    expect(config.browser.captureScreenshotsPerAction).toBe(false);
    expect(config.execution.screenshotOnFailure).toBe(true);
    expect(effective.sources.capture).toBe('server');
  });
});
