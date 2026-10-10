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
 * the turns the step has left. A turn added only to ask runs nothing but those
 * two answers (`isReviewAnswer`): anything else, or a read again that fails,
 * ends the step where it stood. So does having no turn left to show the read
 * (its last turn, or a `return` in the same turn), or an action after it in
 * the same turn that changed the page it read. The step then ends on the
 * read as it came back, and the report says the model never answered it.
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
import { isSecretParameterName } from '../utils/secrets.js';

/** Why a list read is shown to the model. */
export type ListReadConcernKind = 'empty' | 'mixed';

export interface ListReadConcern {
  kind: ListReadConcernKind;
  /** The name the read stored. */
  name: string;
  /**
   * What the selector matched, in one line, with the first few values of each
   * kind: for the model and the report, which show the page text it quotes
   * anyway (the DOM snapshot).
   */
  text: string;
  /**
   * The same line without the values, for the log. A log line reaches the
   * console and a server's event stream as it is, and the values are page
   * text the run's secrets are masked in only as whole values.
   */
  summary: string;
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
 * the selector and a few of the values the read STORED (`MatchGroup.samples`
 * — never text the run did not store; a count quotes none).
 *
 * A value is quoted only whole: masked, and short enough to show as it is. A
 * longer one, or one with line breaks, is given as its length. Cut short, a
 * secret no longer matches the whole value a mask knows — the run's mask now,
 * or the report's at the end of the run, which knows the secrets of later
 * steps too — and its head would stay readable. A list stored under a
 * secret-looking name is described without its values: the mask holds such a
 * list whole, as the text it was stored as, and the line would quote its
 * items one by one.
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
  /** How a value is quoted: whole, or as its length — or not at all. */
  const sample = isSecretParameterName(name) ? undefined : (value: string) => {
    const masked = mask(value);
    return cut(masked) === masked ? JSON.stringify(masked) : `a value of ${masked.length} characters`;
  };

  const stored = counting ? Number(result.capturedValue) : (result.capturedValues ?? []).length;
  if (stored === 0) {
    const matched = groups?.reduce((sum, g) => sum + g.count, 0) ?? 0;
    const line = (quote: typeof sample): string => {
      let why: string;
      if (counting && (result.listMatches?.hidden ?? 0) > 0) {
        const hidden = result.listMatches!.hidden!;
        why = `${selector} matched ${elements(hidden)}, none of them visible, and a count counts only visible ones.`;
      } else if (!counting && matched > 0 && typeof action.pattern === 'string') {
        why = `${selector} matched ${elements(matched)} — ${describeGroups(groups!, quote)} — `
          + `and the pattern /${action.pattern}/ kept none of them.`;
      } else {
        why = `${selector} matched nothing on this page.`;
      }
      return mask(`${name} is ${counting ? '0' : 'empty'}: ${why}`);
    };
    return { kind: 'empty', name, text: line(sample), summary: line(undefined) };
  }

  // The kinds the list's values came from. A count counts every element it
  // matched; a read stores what its pattern kept, and a kind it kept nothing
  // of adds nothing to the list (a group's samples are the values stored from
  // it, so a kind with none stored has none) — a selector that also matches
  // the labels beside the amounts a pattern picks out stores the amounts alone.
  const holding = counting ? groups : groups?.filter((g) => g.samples.length > 0);
  if (groups !== undefined && holding !== undefined && holding.length > 1) {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const what = counting
      ? `${name} is ${stored}, counting ${holding.length} kinds of element`
      : `${name} holds ${stored} value${stored === 1 ? '' : 's'} from ${holding.length} kinds of element`;
    // The kinds that hold the values first: the line names only so many, and
    // the ones a pattern kept nothing of tell the model least.
    const ordered = counting ? groups : [...holding, ...groups.filter((g) => !holding.includes(g))];
    const line = (quote: typeof sample): string =>
      mask(`${what}: ${selector} matched ${elements(total)} — ${describeGroups(ordered, quote)}.`);
    return { kind: 'mixed', name, text: line(sample), summary: line(undefined) };
  }
  return undefined;
}

/** `span.name ×3 ("Ada", "Ben", "Cy"); span.code ×3 ("A-1", …)`, or without the values. */
function describeGroups(groups: MatchGroup[], quote: ((value: string) => string) | undefined): string {
  const shown = groups.slice(0, KINDS_SHOWN).map((g) => {
    if (quote === undefined) return `${g.kind} ×${g.count}`;
    const samples = g.samples.map(quote);
    if (samples.length > 0 && g.count > samples.length) samples.push('…');
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
 * What a turn added only to show the model its list reads may run: keeping
 * them (`noop`), or reading one of them again — the same name, read the same
 * kind of way (a read of every match for one, a count for a count), as the
 * prompt asks. Anything else ends that turn, and the step, where it stood
 * (src/runner/step-executor.ts, `reviewOnly`): a read into another name
 * would leave the read shown unanswered and store over a value the step may
 * hold, and a count into a list's name would store a number for a list.
 */
export function isReviewAnswer(action: AIAction, shown: ReadonlyMap<string, SubActionResult>): boolean {
  if (action.action === 'noop') return true;
  if (!isListRead(action)) return false;
  return shown.get(action.as!)?.action.action === action.action;
}

/** Actions that leave the page as a list read before them saw it. */
const PAGE_KEEPING_ACTIONS: ReadonlySet<string> = new Set([
  'read', 'count', 'readTable', 'find', 'expand', 'noop', 'return', 'extract_csrf', 'extract_value',
]);

/** API requests that only fetch: they leave the page, and the server, as they were. */
const FETCHING_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Whether an action leaves the page as a list read before it in the same
 * turn saw it: another read, a look around (`find`, `expand`), a value taken
 * off the page (`extract_csrf`, `extract_value`), a `noop`, a `return` (it
 * ends the flow, not the page — and the step ends on the read for that
 * reason), an assertion that does not wait, or an API request that only
 * fetches. Anything else may
 * have changed it — a click, a navigation, a tab move, a wait for something
 * to go, a `dialog` answered (accepting a "Delete?" deletes) — and a read
 * again in the next turn would read a different page and store over the
 * step's read (src/runner/step-executor.ts).
 */
export function leavesPageAsRead(action: AIAction): boolean {
  if (action.action === 'assert') return action.poll === undefined;
  if (action.action === 'api_call') return FETCHING_METHODS.has((action.method ?? 'GET').toUpperCase());
  return PAGE_KEEPING_ACTIONS.has(action.action);
}

/**
 * The actions that store what they found into `as` (`storeCapture`,
 * src/runner/store-capture.ts). On any other action `as` stores nothing: it
 * labels a tab (`openPage`) or a browser, or a model added it to a `noop`.
 */
const STORING_ACTIONS: ReadonlySet<string> = new Set(['read', 'count', 'readTable']);

/**
 * The variable an action stores into, if any. A later store of the same name
 * replaces what an earlier one stored.
 */
export function storedName(action: AIAction): string | undefined {
  return typeof action.as === 'string' && action.as !== '' && STORING_ACTIONS.has(action.action)
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
    // A read in a discarded answer stored nothing that stands (`discarded`).
    if (sub.error !== undefined || sub.discarded === true || name === undefined) continue;
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
  for (const sub of standingReviews(result)) {
    const review = sub.listReview!;
    const name = sub.action.as ?? '';
    if (review.kind === 'empty') {
      const what = sub.action.action === 'count' ? 'counted 0' : 'came back empty';
      return {
        kind: 'empty',
        name,
        reason: `{{${name}}} ${what} on the recording run, and a read that finds nothing proves nothing about its selector`,
      };
    }
    if (unanswered(review)) {
      return {
        kind: 'unchecked',
        name,
        reason: `the step ended on its read of {{${name}}} on the recording run without the model checking what it matched`,
      };
    }
  }
  return undefined;
}

/**
 * `unproven` as said of a data-driven test, which compiles from its first data
 * row alone (`firstDataRow`, src/codebehind/compile.ts; a compile-as-you-go
 * run carries `compile` on row 1 only): a list that came back empty there
 * never compiles, whatever the rows after it hold, until a row whose list has
 * items comes first. A list the model never checked needs only another run.
 */
export function onFirstDataRow(unproven: UnprovenListRead): UnprovenListRead {
  return unproven.kind === 'empty'
    ? { ...unproven, reason: `${unproven.reason} — this test compiles from its first data row, so put a row whose list has items first` }
    : unproven;
}

/**
 * The name of a list read the step ended on that the model never answered —
 * empty or mixed, it had no turn left to be shown, the turn that showed it
 * ended without a keep or a read again, or its attempt failed first and the
 * retry never read it again — or undefined when there is none. What the
 * report flags on the step.
 */
export function uncheckedListRead(result: StepResult | undefined): string | undefined {
  const sub = standingReviews(result).find((s) => unanswered(s.listReview!));
  return sub?.action.as;
}

/** The reviewed list reads a step ended on: every one no later action stored over. */
function standingReviews(result: StepResult | undefined): SubActionResult[] {
  const subs = (result?.turns ?? []).flatMap((t) => t.subActions);
  const superseded = supersededListReads(subs);
  return subs.filter(
    (s) => s.listReview !== undefined && s.error === undefined && s.discarded !== true && !superseded.has(s),
  );
}

function unanswered(review: NonNullable<SubActionResult['listReview']>): boolean {
  return review.outcome === 'pending' || review.outcome === 'unseen';
}
