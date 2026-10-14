/**
 * The `steptix.highlight` setting, as the `runSettings.highlight` a run sends
 * (docs/specs/SPEC-interaction-highlight.md §7.2, §13 decision 4).
 *
 * Pure — no `vscode` import — so the one decision with a trap in it is covered
 * under `node --test`. The trap: the server RETAINS run settings per session.
 * Sending `on` once and then nothing would leave the session ringing after the
 * user set the setting back to `default`, so a `default` that follows an
 * override has to be SENT, to clear it. And a `default` that follows nothing is
 * not sent at all: a server older than the setting refuses a `runSettings` key
 * it does not know, and a user who never touched the setting must not find
 * every run refused for it.
 */

/** The setting's values: `default` follows the project's `browser.highlight`. */
export type HighlightSetting = 'default' | 'on' | 'off';

/** The setting as configured; anything unrecognised is `default`. */
export function readHighlightSetting(value: unknown): HighlightSetting {
  return value === 'on' || value === 'off' ? value : 'default';
}

/**
 * What to send for this batch, given what this session was last sent (or
 * `undefined` when nothing has been). `undefined` means send no `runSettings`.
 */
export function highlightRunSettings(
  setting: HighlightSetting,
  lastSent: HighlightSetting | undefined,
): { highlight: HighlightSetting } | undefined {
  if (setting !== 'default') return { highlight: setting };
  return lastSent === 'on' || lastSent === 'off' ? { highlight: 'default' } : undefined;
}
