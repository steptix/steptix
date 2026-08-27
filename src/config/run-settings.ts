/**
 * Merging and resolving per-session run settings (stories/run-settings.md §2–§3).
 *
 * Its own module rather than more private methods on `SessionManager` for two
 * reasons: the resolution is pure — a `Config` in, a `Config` and a provenance
 * record out — and the retention rule is the one thing in this feature that
 * regresses silently, so it wants tests that do not have to stand up a session.
 */
import type {
  CaptureMode,
  Config,
  EffectiveSettings,
  RunSettings,
  SettingSource,
} from './types.js';

/** Accepted `capture` values, in the order an error message should list them. */
export const CAPTURE_MODES: readonly CaptureMode[] = [
  'every-step',
  'on-failure',
  'none',
  'default',
];

/** Keys `runSettings` accepts on the wire. An unknown one is refused rather
 *  than dropped — a caller who misspelled `sendScreenshots` and silently got
 *  nothing has no way to notice. */
export const RUN_SETTING_KEYS: readonly string[] = [
  'model',
  'capture',
  'fullPage',
  'sendScreenshots',
];

/** §3's table, in one place so the route, the resolver and the echo agree. */
const CAPTURE_BOOLEANS: Record<
  Exclude<CaptureMode, 'default'>,
  { perAction: boolean; onFailure: boolean }
> = {
  'every-step': { perAction: true, onFailure: true },
  'on-failure': { perAction: false, onFailure: true },
  none: { perAction: false, onFailure: false },
};

/**
 * Name a `(captureScreenshotsPerAction, screenshotOnFailure)` pair.
 *
 * `'custom'` for per-action-on/failure-off: nobody asks for it through the
 * enum, but a hand-written config can set it, and reporting it as
 * `'every-step'` would tell the reader failures are photographed when they are
 * not.
 */
export function captureModeOf(
  perAction: boolean,
  onFailure: boolean,
): EffectiveSettings['capture'] {
  if (perAction) return onFailure ? 'every-step' : 'custom';
  return onFailure ? 'on-failure' : 'none';
}

/**
 * Fold an incoming `runSettings` over what the session already holds.
 *
 * Per key, and never wholesale: a request carrying only `capture` must leave a
 * previously-set `model` alone. A clearing value (`null`, or `'default'` on the
 * enum) DELETES the key rather than storing the clearing value, so the session
 * ends up holding exactly the overrides that are still in force.
 */
export function mergeRunSettings(
  current: RunSettings,
  incoming: RunSettings | undefined,
): RunSettings {
  if (!incoming) return current;
  const next: RunSettings = { ...current };

  if ('model' in incoming) {
    const model = incoming.model;
    if (typeof model === 'string' && model.trim() !== '') next.model = model.trim();
    else delete next.model;
  }
  if ('capture' in incoming) {
    if (incoming.capture !== undefined && incoming.capture !== 'default') {
      next.capture = incoming.capture;
    } else {
      delete next.capture;
    }
  }
  if ('fullPage' in incoming) {
    if (typeof incoming.fullPage === 'boolean') next.fullPage = incoming.fullPage;
    else delete next.fullPage;
  }
  if ('sendScreenshots' in incoming) {
    if (typeof incoming.sendScreenshots === 'boolean') {
      next.sendScreenshots = incoming.sendScreenshots;
    } else {
      delete next.sendScreenshots;
    }
  }

  return next;
}

/** A value plus which layer decided it. */
interface Sourced<T> {
  value: T;
  from: SettingSource;
}

/**
 * Where a base value came from, decided by comparison.
 *
 * The project bundle always *has* a value for these keys — `loadConfig`
 * deep-merges the project's JSON over the defaults — so "did the file set it?"
 * is not answerable from the merged config alone. Comparing against the
 * server's own value answers the question that matters instead: when they
 * agree, `'server'` is true either way; when they differ, the project's config
 * is precisely what produced the difference.
 */
function base<T>(serverValue: T, projectValue: T): Sourced<T> {
  return projectValue === serverValue
    ? { value: serverValue, from: 'server' }
    : { value: projectValue, from: 'project' };
}

export interface ResolvedRunSettings {
  /**
   * The complete `Config` to hand the executor.
   *
   * `serverConfig` spread with ONLY named values re-sourced: run-settings' own
   * four, plus `browser.ambiguousTarget`
   * (stories/codebehind-selector-ambiguity.md). It has to be complete rather
   * than partial — both executor call sites take the whole object — and it
   * deliberately leaves every other value exactly as the server startup config
   * has it. Re-basing the executor on the project bundle wholesale is the
   * correct-but-deferred change §2 describes.
   *
   * That deferral is why this list has to grow by hand, and the growth is the
   * trap: a new per-project `browser.*` key that is not named here reaches the
   * CLI correctly and is silently the server's value everywhere else. Adding
   * one to `ProjectBundle` alone does not reach the executor.
   */
  config: Config;
  effective: EffectiveSettings;
}

/**
 * Resolve one batch's settings: server base → project bundle → session
 * overrides.
 *
 * `envModel` is the model AFTER `applyEnvToAiConfig` — i.e. the project's
 * `.env` layered over the server base — which is why a model that came from
 * `.env` reports as `'project'` and one the agent asked for reports as
 * `'session'`. Keeping those apart is the whole reason the model override is
 * its own field instead of an injected `env.AI_MODEL`.
 */
export function resolveRunSettings(
  serverConfig: Config,
  /** The per-batch project bundle's config. Pass `serverConfig` when there is
   *  no project root — the comparison then reports everything as `'server'`. */
  projectConfig: Config,
  envModel: string,
  overrides: RunSettings,
): ResolvedRunSettings {
  // `!== false` matches how step-executor.ts reads this flag, so an absent
  // value keeps meaning "on" rather than flipping when we write it back out.
  const perActionBase = base(
    serverConfig.browser.captureScreenshotsPerAction !== false,
    projectConfig.browser.captureScreenshotsPerAction !== false,
  );
  const onFailureBase = base(
    serverConfig.execution.screenshotOnFailure,
    projectConfig.execution.screenshotOnFailure,
  );
  let perAction = perActionBase.value;
  let onFailure = onFailureBase.value;
  // One source for the pair: they are two halves of one setting as far as the
  // caller is concerned, so a project that moved either half reports 'project'.
  let captureFrom: SettingSource =
    perActionBase.from === 'project' || onFailureBase.from === 'project' ? 'project' : 'server';
  const captureOverride = overrides.capture;
  if (captureOverride !== undefined && captureOverride !== 'default') {
    ({ perAction, onFailure } = CAPTURE_BOOLEANS[captureOverride]);
    captureFrom = 'session';
  }

  const fullPageBase = base(
    serverConfig.browser.fullPageScreenshots,
    projectConfig.browser.fullPageScreenshots,
  );
  let fullPage = fullPageBase.value;
  let fullPageFrom = fullPageBase.from;
  if (typeof overrides.fullPage === 'boolean') {
    fullPage = overrides.fullPage;
    fullPageFrom = 'session';
  }

  // Re-sourced for the same reason the capture settings are, and it is easy to
  // miss why it has to be: `config.browser` below is spread from the SERVER's
  // startup config, so any key not named there silently keeps the server's
  // answer no matter what the project's `aiui.config.json` says. Routing the
  // value onto the project bundle is necessary but NOT sufficient — this is the
  // second place it would be dropped, and the only one the executor reads.
  // Whether an ambiguous click fails belongs to the suite under test, not to
  // whichever checkout happened to start the server.
  // No normalising here on purpose: the gate downstream is `=== 'fail'`, so an
  // absent value or a typo already means 'first'.
  const ambiguousBase = base(
    serverConfig.browser.ambiguousTarget,
    projectConfig.browser.ambiguousTarget,
  );

  const sendBase = base(serverConfig.ai.sendScreenshots, projectConfig.ai.sendScreenshots);
  let sendScreenshots = sendBase.value;
  let sendFrom = sendBase.from;
  if (typeof overrides.sendScreenshots === 'boolean') {
    sendScreenshots = overrides.sendScreenshots;
    sendFrom = 'session';
  }

  let model = envModel;
  let modelFrom: SettingSource = envModel === serverConfig.ai.model ? 'server' : 'project';
  if (typeof overrides.model === 'string' && overrides.model.trim() !== '') {
    model = overrides.model.trim();
    modelFrom = 'session';
  }

  return {
    config: {
      ...serverConfig,
      ai: { ...serverConfig.ai, model, sendScreenshots },
      browser: {
        ...serverConfig.browser,
        captureScreenshotsPerAction: perAction,
        fullPageScreenshots: fullPage,
        ambiguousTarget: ambiguousBase.value,
      },
      execution: { ...serverConfig.execution, screenshotOnFailure: onFailure },
    },
    effective: {
      model,
      capture: captureModeOf(perAction, onFailure),
      fullPage,
      sendScreenshots,
      sources: {
        model: modelFrom,
        capture: captureFrom,
        fullPage: fullPageFrom,
        sendScreenshots: sendFrom,
      },
    },
  };
}
