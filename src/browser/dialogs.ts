import type { BrowserContext, Dialog } from 'playwright';
import { logger } from '../utils/logger.js';

/**
 * Browser dialogs: how the next one is answered, and what each one said
 * (docs/specs/SPEC-web-survey-fixes.md §2.1).
 *
 * A dialog cannot wait for the model. While one is open the page is blocked,
 * and every `evaluate` — the DOM snapshot included — hangs until it is
 * answered. So the answer is decided BEFORE the dialog opens: a `dialog`
 * action arms it, the guard in manager.ts takes the armed answer when the
 * dialog arrives, and anything not armed gets the old default (accept
 * `beforeunload`, dismiss the rest).
 *
 * Every dialog is also RECORDED, because the model never sees one otherwise:
 * a confirm opened and closed between two snapshots. The record is shown in
 * the next snapshot ({@link takeUnshownDialogs}) and copied into the page as
 * `window.__steptixDialogs`, which is what lets an assertion check what an
 * alert said.
 */

/** One dialog the session saw. */
export interface DialogRecord {
  /** `alert`, `confirm`, `prompt` or `beforeunload`. */
  type: string;
  message: string;
  /** How it was answered. */
  answer: 'accepted' | 'dismissed';
  /** The text a prompt was answered with, when it was accepted with one. */
  text?: string;
  /** Whether a `dialog` action chose the answer, or the default did. */
  armed: boolean;
  /** Epoch ms. */
  at: number;
  /** Shown in a snapshot yet. */
  shown: boolean;
  /** Reported to a `dialog` action that arrived after it was answered. */
  reported: boolean;
}

interface ArmedAnswer {
  accept: boolean;
  text?: string;
}

interface DialogState {
  armed?: ArmedAnswer;
  records: DialogRecord[];
}

/** The most recent dialogs kept per context. Older ones are dropped. */
const MAX_RECORDS = 20;

const states = new WeakMap<BrowserContext, DialogState>();

function stateOf(context: BrowserContext): DialogState {
  let state = states.get(context);
  if (state === undefined) {
    state = { records: [] };
    states.set(context, state);
  }
  return state;
}

/** Set how the next dialog in this context is answered. Replaces any earlier
 *  setting: the last `dialog` action sent is the one the author meant. */
export function armDialog(context: BrowserContext, answer: ArmedAnswer): void {
  stateOf(context).armed = answer;
}

/** Forget an armed answer that no dialog used. Called at the start of each
 *  step, so a `dialog` action never answers a dialog in a later step. */
export function disarmDialog(context: BrowserContext): void {
  const state = states.get(context);
  if (state !== undefined) delete state.armed;
}

/**
 * The dialogs answered by the DEFAULT, in this context, that no `dialog`
 * action has been told about yet — then marks them told.
 *
 * A `dialog` action that arrives after its dialog has already been answered
 * cannot change that answer. Reporting the dialog once lets the step say so,
 * and the model's retry (dialog first, then the click again) succeeds instead
 * of being refused forever over the same old dialog.
 */
export function takeUnreportedDefaultAnswers(context: BrowserContext, sinceMs: number): DialogRecord[] {
  const state = states.get(context);
  if (state === undefined) return [];
  const found = state.records.filter((r) => !r.armed && !r.reported && r.at >= sinceMs);
  for (const record of found) record.reported = true;
  return found;
}

/** Dialogs not yet shown in a snapshot, marked shown. */
export function takeUnshownDialogs(context: BrowserContext): DialogRecord[] {
  const state = states.get(context);
  if (state === undefined) return [];
  const found = state.records.filter((r) => !r.shown);
  for (const record of found) record.shown = true;
  return found;
}

/** Every dialog the context has recorded, oldest first. */
export function dialogRecords(context: BrowserContext): readonly DialogRecord[] {
  return states.get(context)?.records ?? [];
}

/** One line per dialog, for the model. */
export function describeDialogs(records: readonly DialogRecord[]): string {
  return records
    .map((r) => {
      const said = r.message ? `"${r.message}"` : '(no message)';
      const how = r.text !== undefined ? `${r.answer} with "${r.text}"` : r.answer;
      return `[${r.type}] ${said} — ${how}${r.armed ? '' : ' by default'}`;
    })
    .join('\n');
}

/**
 * Answer `dialog`, as armed or by default, and record it. Every path ends in
 * an accept or a dismiss: once anyone listens for dialogs, nothing else will
 * answer one, and an unanswered dialog blocks the page for the rest of the run.
 */
export function answerDialog(context: BrowserContext, dialog: Dialog): void {
  const state = stateOf(context);
  const type = dialog.type();
  const armed = state.armed;
  // An armed answer is for an alert, confirm or prompt. `beforeunload` keeps
  // its default, because dismissing one silently cancels a navigation.
  const useArmed = armed !== undefined && type !== 'beforeunload';
  if (useArmed) delete state.armed;

  const accept = useArmed ? armed.accept : type === 'beforeunload';
  const text = useArmed && accept && type === 'prompt' ? armed.text : undefined;
  const record: DialogRecord = {
    type,
    message: dialog.message(),
    answer: accept ? 'accepted' : 'dismissed',
    ...(text !== undefined && { text }),
    armed: useArmed,
    at: Date.now(),
    shown: false,
    reported: false,
  };
  state.records.push(record);
  if (state.records.length > MAX_RECORDS) state.records.splice(0, state.records.length - MAX_RECORDS);

  const where = dialog.page()?.url() ?? 'unknown page';
  logger.info(
    `Browser dialog [${type}] ${useArmed ? '' : 'auto-'}${record.answer}` +
      `${text !== undefined ? ` with "${text}"` : ''} on ${where}` +
      (record.message ? `: ${record.message}` : ''),
  );

  const answered = accept ? dialog.accept(text) : dialog.dismiss();
  void answered
    .then(() => publishToPage(dialog, state.records))
    .catch((err: unknown) => {
      logger.debug(
        `Dialog [${type}] could not be ${record.answer} — ` +
          `it was already gone (${err instanceof Error ? err.message : String(err)})`,
      );
    });
}

/**
 * Copy the record into the page as `window.__steptixDialogs`, after the
 * dialog is answered and the page is free again. Best effort: a page that
 * navigated away, or forbids scripts, simply does not get it.
 */
function publishToPage(dialog: Dialog, records: readonly DialogRecord[]): void {
  const page = dialog.page();
  if (!page) return;
  const payload = records.map(({ type, message, answer, text }) => ({
    type,
    message,
    answer,
    ...(text !== undefined && { text }),
  }));
  void page
    .evaluate((list) => {
      (globalThis as unknown as { __steptixDialogs: unknown }).__steptixDialogs = list;
    }, payload)
    .catch(() => {});
}
