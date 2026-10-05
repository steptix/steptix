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
  // Keyed on purpose: with no key every resolution would report `ai: 'off'` for
  // want of one, and the policy cases below could not be told from that.
  ai: { ...DEFAULT_CONFIG.ai, model: 'server/model', sendScreenshots: false, apiKey: 'k' },
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

  it('retains ai per key, and "default" deletes it', () => {
    const off = mergeRunSettings({}, { ai: 'off' });
    expect(off).toEqual({ ai: 'off' });

    // A later request about something else must not lift the switch.
    expect(mergeRunSettings(off, { capture: 'none' })).toEqual({ ai: 'off', capture: 'none' });

    const cleared = mergeRunSettings(off, { ai: 'default' });
    expect(cleared).toEqual({});
    expect('ai' in cleared).toBe(false);
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
    // enum, but a hand-written steptix.config.json can set it — and rounding it to
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
      ai: 'on',
      aiOffReason: null,
      sources: {
        model: 'server',
        capture: 'server',
        fullPage: 'server',
        sendScreenshots: 'server',
        ai: 'server',
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

describe('resolveRunSettings — browser.ambiguousTarget', () => {
  // The executor's `browser` slice is SPREAD from the server's startup config,
  // so a per-project key that is not re-sourced by name silently keeps the
  // server's answer. Putting the value on `ProjectBundle` does not fix that —
  // this is a second, independent drop point, and the only one the executor
  // actually reads. Both directions are asserted because a resolver that just
  // echoed the server config would pass a naive one-way check.
  const failProject: Config = {
    ...server,
    browser: { ...server.browser, ambiguousTarget: 'fail' },
  };

  it("carries the PROJECT's 'fail' into the config handed to the executor", () => {
    const { config } = resolve({}, failProject);

    expect(config.browser.ambiguousTarget).toBe('fail');
  });

  it('does not let a server set to "fail" impose it on a silent project', () => {
    const failServer: Config = {
      ...server,
      browser: { ...server.browser, ambiguousTarget: 'fail' },
    };
    const { config } = resolveRunSettings(failServer, server, failServer.ai.model, {});

    expect(config.browser.ambiguousTarget).toBe('first');
  });

  it('leaves the rest of the browser slice untouched', () => {
    const { config } = resolve({}, failProject);

    expect(config.browser.captureScreenshotsPerAction).toBe(false);
    expect(config.browser.fullPageScreenshots).toBe(false);
    expect(config.browser.browser).toBe(server.browser.browser);
  });
});

describe('resolveRunSettings — the AI switch', () => {
  // stories/run-settings.md §9. `server` above is keyed, so every `off` here is
  // a POLICY answer; the no-key cases build their own config.
  const keyless: Config = { ...server, ai: { ...server.ai, apiKey: '' } };

  it('is on by default, sourced from the server', () => {
    const { effective, config } = resolve({});

    expect(effective.ai).toBe('on');
    expect(effective.aiOffReason).toBeNull();
    expect(effective.sources.ai).toBe('server');
    expect(config.ai.allowInRuns).toBe(true);
  });

  it('a session override turns it off, and says policy', () => {
    const { effective, config } = resolve({ ai: 'off' });

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('policy');
    expect(effective.sources.ai).toBe('session');
    expect(config.ai.allowInRuns).toBe(false);
  });

  it("carries the PROJECT's allowInRuns into the config handed to the executor", () => {
    // The trap this list's own comment names: `config.ai` below is spread from
    // the SERVER's startup config, so a per-project key not re-sourced BY NAME
    // silently keeps the server's answer. Routing it onto the project bundle is
    // necessary and not sufficient — this is the second drop point.
    const project: Config = { ...server, ai: { ...server.ai, allowInRuns: false } };
    const { effective, config } = resolve({}, project);

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('policy');
    expect(effective.sources.ai).toBe('project');
    expect(config.ai.allowInRuns).toBe(false);
  });

  it('does not let a server that forbids AI impose it on a silent project', () => {
    // The other direction, for `ambiguousTarget`'s reason: a resolver that just
    // echoed the server config would pass the check above and fail here.
    const noAiServer: Config = { ...server, ai: { ...server.ai, allowInRuns: false } };
    const { effective } = resolveRunSettings(noAiServer, server, noAiServer.ai.model, {});

    expect(effective.ai).toBe('on');
    expect(effective.sources.ai).toBe('project');
  });

  it('a session "on" beats a project that forbids it', () => {
    const project: Config = { ...server, ai: { ...server.ai, allowInRuns: false } };
    const { effective, config } = resolve({ ai: 'on' }, project);

    expect(effective.ai).toBe('on');
    expect(effective.sources.ai).toBe('session');
    expect(config.ai.allowInRuns).toBe(true);
  });

  it('"default" resolves to the base rather than the last override', () => {
    const project: Config = { ...server, ai: { ...server.ai, allowInRuns: false } };
    const { effective } = resolve({ ai: 'default' }, project);

    expect(effective.ai).toBe('off');
    expect(effective.sources.ai).toBe('project');
  });

  it('reports no-key when a run has no key, without calling it policy', () => {
    // The distinction the echo exists to keep. Nothing was chosen here, so the
    // source stays where the policy came from.
    const { effective } = resolveRunSettings(keyless, keyless, keyless.ai.model, {});

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('no-key');
    expect(effective.sources.ai).toBe('server');
  });

  it('reads the key off the ai config it is GIVEN, not the server base', () => {
    // The server may be keyless while the request's `.env` shipped a key, and
    // vice versa — which is exactly the shape the executor's `keyless` flag had
    // to be fixed for once already.
    const withKey = resolveRunSettings(keyless, keyless, keyless.ai.model, {}, {
      ai: { ...keyless.ai, apiKey: 'from-dot-env' },
    });
    expect(withKey.effective.ai).toBe('on');

    const withoutKey = resolveRunSettings(server, server, server.ai.model, {}, {
      ai: { ...server.ai, apiKey: '' },
    });
    expect(withoutKey.effective.ai).toBe('off');
    expect(withoutKey.effective.aiOffReason).toBe('no-key');
  });

  it('calls it policy when the run is BOTH keyless and forbidden', () => {
    // A key is not the fix on a run that was asked to spend nothing, so
    // reporting 'no-key' would send support to correct a line that is fine.
    const { effective } = resolveRunSettings(keyless, keyless, keyless.ai.model, { ai: 'off' });

    expect(effective.aiOffReason).toBe('policy');
  });

  it('bypasses the policy for a request FOR AI, without touching the overrides', () => {
    // Compile, Repair This Step and errands. The session's retained `off` has
    // to survive: the alternative — compile sending `runSettings: {ai: "on"}` —
    // would be merged and silently clobber it for every later run.
    const overrides: RunSettings = { ai: 'off' };
    const { effective, config } = resolveRunSettings(server, server, server.ai.model, overrides, {
      bypassAiPolicy: true,
    });

    expect(effective.ai).toBe('on');
    expect(effective.sources.ai).toBe('server');
    expect(config.ai.allowInRuns).toBe(true);
    expect(overrides).toEqual({ ai: 'off' });
  });

  it('does not conjure AI out of a bypass when there is no key', () => {
    // The bypass lifts a POLICY. A compile on a machine with no model is still
    // a compile with no model, and must say so.
    const { effective } = resolveRunSettings(keyless, keyless, keyless.ai.model, { ai: 'off' }, {
      bypassAiPolicy: true,
    });

    expect(effective.ai).toBe('off');
    expect(effective.aiOffReason).toBe('no-key');
  });

  it('leaves every other config value alone while flipping the switch', () => {
    const { config } = resolve({ ai: 'off' });

    expect(config.ai.model).toBe('server/model');
    expect(config.ai.maxInputTokens).toBe(server.ai.maxInputTokens);
    expect(config.ai.diagnoseFailures).toBe(server.ai.diagnoseFailures);
    expect(config.browser.captureScreenshotsPerAction).toBe(false);
  });
});
