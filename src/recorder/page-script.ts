import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSecretFieldRule } from '../browser/dom-cleaner.js';

/**
 * The name the recorder's binding is exposed under on every frame's `window`
 * (`context.exposeBinding`). Fixed for the life of the process: a context can
 * expose a name once and never again, so every recording on one session's
 * browser shares the binding the first one installed.
 */
export const RECORD_BINDING_NAME = '__aiuiRecordSteps';

/**
 * The non-enumerable `window` property the page script exposes for the server:
 * `setState({ recording, pick, paused, bar, toolbar? }, key)`, `flush(key)`,
 * `fieldRects(ask, key)`, `claim(token, key)` (the document's toolbar token,
 * accepted once) and `toolbar(command, key)` (a shortcut pressed in a frame,
 * carried out in the tab's top document).
 *
 * Every one of them does nothing without the context's control key (see
 * {@link recordStepsPageScript}): the object is on `window`, so the page's own
 * scripts can call it.
 */
export const RECORD_CONTROL_NAME = '__aiuiRecordStepsCtl';

let cached: string | null = null;

/**
 * The page script with its placeholders filled — the text both
 * `context.addInitScript` and the evaluate into already-open frames run.
 *
 * Loaded from `src/browser/scripts/record-steps.js` beside the other page
 * scripts (the build copies that directory into `dist/`), with the one
 * `isSecretField` the snapshot uses spliced in.
 *
 * `key` is the control key, written into the script's closure: the control
 * object's methods answer only a caller that passes it, and the server passes
 * it as an evaluate ARGUMENT — never through the binding, never in a page
 * global. One per browser context, because the init script is installed once
 * per context and cannot be changed (stories/testbench-record-toolbar.md,
 * "The page cannot drive the toolbar"). A page script that calls `claim('x')`
 * before the recorder's own claim therefore gets `false`, and cannot take the
 * document's toolbar away from it.
 */
export function recordStepsPageScript(key: string): string {
  return baseScript().split('__CONTROL_KEY__').join(JSON.stringify(key));
}

function baseScript(): string {
  if (cached !== null) return cached;
  const url = new URL('../browser/scripts/record-steps.js', import.meta.url);
  const template = readFileSync(fileURLToPath(url), 'utf8');
  // The toolbar (stories/testbench-record-toolbar.md) lives in its own file
  // and is spliced into the recorder's closure: it shares that script's
  // state, its token and its describers.
  const toolbar = readFileSync(fileURLToPath(new URL('../browser/scripts/record-toolbar.js', import.meta.url)), 'utf8');
  cached = template
    .split('__RECORD_TOOLBAR__')
    .join(toolbar)
    .split('__SECRET_FIELD_RULE__')
    .join(loadSecretFieldRule())
    .split('__BINDING_NAME__')
    .join(JSON.stringify(RECORD_BINDING_NAME))
    .split('__CONTROL_NAME__')
    .join(JSON.stringify(RECORD_CONTROL_NAME));
  return cached;
}
