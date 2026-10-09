/**
 * A list read the model looks at before the step ends on it
 * (steptix/steptix#48, which #28 was merged into).
 *
 * When a step reads every match of a selector, or counts them, the model
 * picks the selector and Steptix stores whatever it matched. A selector that
 * is slightly wrong still "works": it matches nothing and an empty list is
 * stored, or it matches the items and their neighbours and the extra values
 * are stored. A `For each` over the first runs zero times; over the second it
 * checks things the test never meant to check. Both passed, because the model
 * never saw what its selector matched.
 *
 * So two outcomes are shown to the model before the step may end on them:
 *
 *  - **empty** — the read stored no values, or the count is 0;
 *  - **mixed** — the elements it matched are of more than one kind, kinds
 *    named as compiled reads name them (tag plus class names without a
 *    digit; docs/specs/SPEC-codebehind-robustness.md §6.6).
 *
 * The model then reads again with a better selector, which replaces the read,
 * or keeps it. Neither outcome is a failure — an empty list and a row of cells
 * with different classes are both real answers — so this only ever asks, in
 * the turns the step has left. A step that ends on one with no turn left to
 * show it (its last turn, or a `return` in the same turn) ends on it as read,
 * and the report says the model never saw it.
 *
 * What the compile may use is decided here too. A read that a later action
 * stored over is not the step's read, so the transcript leaves it out
 * (`supersededListReads`). A step that ends on a list that came back empty,
 * or on one the model never saw, is no evidence for its selector — on a page
 * with no items every selector matches nothing — so the compile writes no
 * entry for it and compiles it from a run that found something
 * (`unprovenListRead`).
 *
 * Nothing here knows a site: the line is built from what the page answered.
 */
import type { AIAction } from '../ai/types.js';
import type { ActionExecutionResult, MatchGroup } from '../browser/actions.js';
import type { StepResult, SubActionResult } from '../report/types.js';

/** Why a list read is shown to the model. */
export type ListReadConcernKind = 'empty' | 'mixed';

export interface ListReadConcern {
  kind: ListReadConcernKind;
  /** The name the read stored. */
  name: string;
  /** What the selector matched, in one line: for the model, the log and the report. */
  text: string;
}

/** Kinds named in one line before the rest are summed up. */
const KINDS_SHOWN = 5;
/** A sample longer than this is cut, with an ellipsis. */
const SAMPLE_CHARS = 60;

/**
 * A read of every match, or a count, that stores what it found — the reads
 * this module looks at. A single read is not one: it fails by itself when its
 * selector matches nothing.
 */
export function isListRead(action: AIAction): boolean {
  if (typeof action.as !== 'string' || action.as === '') return false;
  return action.action === 'count' || (action.action === 'read' && action.multiple === true);
}

/**
 * The concern about a list read that succeeded, or undefined when there is
 * none — not a list read, a list of one kind, or a page that could not say
 * what it matched. `mask` hides the run's secrets in the line, which quotes
 * page text and the selector.
 */
export function listReadConcern(
  action: AIAction,
  result: ActionExecutionResult,
  mask: (text: string) => string = (text) => text,
): ListReadConcern | undefined {
  if (!result.success || !isListRead(action)) return undefined;
  const name = action.as!;
  const selector = `\`${action.selector ?? ''}\``;
  const groups = result.listMatches?.groups;
  const counting = action.action === 'count';

  const stored = counting ? Number(result.capturedValue) : (result.capturedValues ?? []).length;
  if (stored === 0) {
    const matched = groups?.reduce((sum, g) => sum + g.count, 0) ?? 0;
    let why: string;
    if (counting && (result.listMatches?.hidden ?? 0) > 0) {
      const hidden = result.listMatches!.hidden!;
      why = `${selector} matched ${elements(hidden)}, none of them visible, and a count counts only visible ones.`;
    } else if (!counting && matched > 0 && typeof action.pattern === 'string') {
      why = `${selector} matched ${elements(matched)} — ${describeGroups(groups!)} — `
        + `and the pattern /${action.pattern}/ kept none of them.`;
    } else {
      why = `${selector} matched nothing on this page.`;
    }
    return { kind: 'empty', name, text: mask(`${name} is ${counting ? '0' : 'empty'}: ${why}`) };
  }

  if (groups !== undefined && groups.length > 1) {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const what = counting
      ? `${name} is ${stored}, counting ${groups.length} kinds of element`
      : `${name} holds ${stored} value${stored === 1 ? '' : 's'} from ${groups.length} kinds of element`;
    return {
      kind: 'mixed',
      name,
      text: mask(`${what}: ${selector} matched ${elements(total)} — ${describeGroups(groups)}.`),
    };
  }
  return undefined;
}

/** `span.name ×3 ("Ada", "Ben", "Cy"); span.code ×3 ("A-1", …)`. */
function describeGroups(groups: MatchGroup[]): string {
  const shown = groups.slice(0, KINDS_SHOWN).map((g) => {
    const samples = g.samples.map((s) => JSON.stringify(cut(s)));
    if (g.count > g.samples.length) samples.push('…');
    return `${g.kind} ×${g.count}${samples.length > 0 ? ` (${samples.join(', ')})` : ''}`;
  });
  const rest = groups.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more kind${rest === 1 ? '' : 's'}` : '');
}

function cut(sample: string): string {
  const flat = sample.replace(/\s+/g, ' ').trim();
  return flat.length > SAMPLE_CHARS ? `${flat.slice(0, SAMPLE_CHARS - 1)}…` : flat;
}

function elements(n: number): string {
  return `${n} element${n === 1 ? '' : 's'}`;
}

/**
 * Whether two list reads read the same way — so a model shown the first that
 * answers with the second has kept it, not replaced it with a new guess.
 */
export function sameListRead(a: AIAction, b: AIAction): boolean {
  return a.action === b.action
    && a.selector === b.selector
    && a.as === b.as
    && (a.multiple === true) === (b.multiple === true)
    && a.attribute === b.attribute
    && a.pattern === b.pattern
    && a.frame === b.frame
    && (a.includeHidden === true) === (b.includeHidden === true);
}

/**
 * The variable an action stores into, if any: its `as`, except on `openPage`,
 * where `as` labels the tab (`AIAction.as`). A later store of the same name
 * replaces what an earlier one stored.
 */
export function storedName(action: AIAction): string | undefined {
  return typeof action.as === 'string' && action.as !== '' && action.action !== 'openPage'
    ? action.as
    : undefined;
}

/**
 * The reviewed list reads a later action stored over, in a step's
 * sub-actions in run order. Storing a name replaces what it held, so the
 * value the step ended with came from the later action, and the earlier read
 * is not the step's read: one the model replaced when it was shown it, or one
 * an attempt that failed left behind and the retry read again. A step's turns
 * hold every attempt's, which is why this looks across them.
 *
 * Reads that were never reviewed are left alone, as they were before reviews
 * existed.
 */
export function supersededListReads(subs: readonly SubActionResult[]): Set<SubActionResult> {
  const superseded = new Set<SubActionResult>();
  const latest = new Map<string, SubActionResult>();
  for (const sub of subs) {
    const name = storedName(sub.action);
    if (sub.error !== undefined || name === undefined) continue;
    const earlier = latest.get(name);
    if (earlier?.listReview !== undefined) superseded.add(earlier);
    latest.set(name, sub);
  }
  return superseded;
}

/** Why a step's list read gives the compile nothing to stand on. */
export interface UnprovenListRead {
  /**
   * `empty` — the step stored a list that came back empty, or a count of 0;
   * `unchecked` — it stored a list the model never saw.
   */
  kind: 'empty' | 'unchecked';
  /** The name the read stored. */
  name: string;
  /** The compile's line about the step, said of the run it compiles from. */
  reason: string;
}

/**
 * Why the compile cannot use this step's run, or undefined when it can: the
 * step ended on a list read that came back empty — kept by the model or not —
 * or on one the model never answered.
 *
 * Empty because a read that finds nothing proves nothing about its selector:
 * on a page with no items, a selector one level too deep and the right one
 * both match nothing, and compiled, either would pass on that page for good.
 * Never answered because nobody looked at what it matched. The step stays
 * under AI with no entry, which the next compile takes again, rather than an
 * `ai: true` entry, which every later compile would leave alone.
 */
export function unprovenListRead(result: StepResult | undefined): UnprovenListRead | undefined {
  const subs = (result?.turns ?? []).flatMap((t) => t.subActions);
  const superseded = supersededListReads(subs);
  for (const sub of subs) {
    const review = sub.listReview;
    if (review === undefined || sub.error !== undefined || superseded.has(sub)) continue;
    const name = sub.action.as ?? '';
    if (review.kind === 'empty') {
      const what = sub.action.action === 'count' ? 'counted 0' : 'came back empty';
      return {
        kind: 'empty',
        name,
        reason: `{{${name}}} ${what} on the recording run, and a read that finds nothing proves nothing about its selector`,
      };
    }
    if (review.outcome === 'pending' || review.outcome === 'unseen') {
      return {
        kind: 'unchecked',
        name,
        reason: `the step ended on its read of {{${name}}} on the recording run before the model could check what it matched`,
      };
    }
  }
  return undefined;
}
