/**
 * A list read the step cannot end on unseen (issue #28).
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
 * or keeps it. Neither outcome is a failure in itself — an empty list and a
 * row of cells with different classes are both real answers — so this only
 * asks. What the step loop refuses is a step that ENDS on one the model has
 * not seen, and only a read the model kept is compiled
 * (`listReadCompiles`, src/codebehind/recording.ts).
 *
 * Nothing here knows a site: the line is built from what the page answered.
 */
import type { AIAction } from '../ai/types.js';
import type { ActionExecutionResult, MatchGroup } from '../browser/actions.js';
import type { SubActionResult } from '../report/types.js';

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
 * The step's error when it would end on a list read the model has not seen
 * and there is no turn left to show it.
 */
export function unseenListReadError(concerns: ListReadConcern[]): string {
  const lines = concerns.map((c) => c.text).join(' ');
  return `The step would end on a list read that came back empty or mixed, with no turn left to look at it: ${lines} `
    + 'Read it with a selector that matches only what the step asks for. If that is the answer, keep it when the read is shown to you.';
}

/**
 * Whether the compile may use this sub-action: anything but a list read that
 * was shown to the model and not kept — replaced by a later read, or never
 * answered because the attempt failed first.
 */
export function listReadCompiles(sub: SubActionResult): boolean {
  return sub.listReview === undefined || sub.listReview.outcome === 'kept';
}
