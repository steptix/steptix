/**
 * A retry of a failed check asks the same question (steptix/steptix#97).
 *
 * A check is made by two AI calls: the step AI decides WHAT to check — the
 * question (`condition`) and the `expected` value — and the code AI decides
 * HOW to read the page, the selectors and JavaScript. When a check came back
 * false, the retry used to ask the step AI to plan the step again, and it
 * wrote a new check: one changed the page until the check passed (a filter
 * re-typed key by key), another asked an easier question ("the Northside
 * Dental option's text" for "Northside Dental and no other payee") and passed.
 *
 * So the attempt right after a check came back false does not ask the step
 * AI for a new check. Its first turn runs the failed check again — the same
 * `assert`, so the same question and expected value ({@link recheckResponse})
 * — with the same code ({@link codeToRunAgain}). Code written anew after the
 * old code had read the page and answered read the page another way, and
 * passed a check that must fail. The code is written anew only when the old
 * code found no element, was written for a value read again since, would
 * change the page, or breaks when it runs again, told what the old code read
 * and why it failed ({@link recheckNote}), so a wrong selector or JavaScript
 * that does not work can still be fixed. That code is not told where on the
 * page the expected text is, which the step's failure may say
 * (SPEC-web-survey-fixes.md §2.25): the part to read is the one the condition
 * names, and pointed at the expected text it could read another row that
 * holds it and pass. Code that would change the page, as far as
 * `checkCodeMutation` (codebehind/generate.ts) can tell — the old code, or
 * new code — is not run but written again, told why
 * ({@link checkCodeReadsOnly}).
 *
 *  - Fails again: the step fails with the check's result. With
 *    `execution.retries` above 1, the next attempt asks the same question —
 *    as it does when the re-check came to no verdict: its code failed or was
 *    refused on both tries, a value it read again could not be read, or the
 *    attempt failed before the check had a result.
 *  - Passes: if the answer the check failed in had more to do — an action
 *    after the check, or `needs_reeval` ({@link FailedCheck.hadMore}) — the
 *    step AI does the rest, told what the failed attempt already did
 *    ({@link FailedCheck.done}); else the step is done. The turn that
 *    re-checks asks the step AI for nothing, so it does not count against
 *    `execution.maxTurns`: the step AI still has every turn.
 *
 * Not re-checked, but retried as before, with the step AI planning again and
 * the code AI of each check it writes told how checks failed before, as far
 * as those failures were recorded and still stand
 * ({@link earlierFailuresNote} of {@link earlierCheckErrors},
 * SPEC-web-survey-fixes.md §2.25):
 *  - a step whose first check's code failed (it threw, returned the wrong
 *    shape or never parsed): it has no verdict, and its code was already
 *    written again within the attempt — nor does it record a failure, so the
 *    retry is told nothing of it;
 *  - an `If …, then return / stop / fail` line: its check may be the
 *    condition, or something the line verifies after acting, and only the
 *    step AI planning it again can tell which;
 *  - every failure that is not a check, unless it ended an attempt that
 *    re-checks before the check had a result: that attempt came to no
 *    verdict, and the next asks the same question (above).
 *
 * On a step that re-checks, no recorded check failure still stands by then —
 * every one was asked again and passed — so in practice only an `If …, then
 * …` line's retries are told how checks failed.
 */
import type { AIAction, AIResponse } from './types.js';
import type { FailedCheck, PriorFailureContext } from './prompts.js';

/**
 * The plan for the turn that re-checks: the failed check, as it was sent —
 * after the reads that stored a value since an action last changed the page
 * before it ({@link FailedCheck.rereads}), so a value read before the page had
 * loaded is read again rather than checked stale. They only read.
 */
export function recheckResponse(check: FailedCheck): AIResponse {
  return {
    actions: [...check.rereads, check.action],
    reasoning: `Checking again: ${check.action.description}`,
    ...(check.hadMore && { needs_reeval: true }),
  };
}

/**
 * Do two `assert` actions ask the same question? The re-check sends the
 * failed one unchanged, so its failures across attempts compare equal.
 */
export function sameCheck(a: AIAction, b: AIAction): boolean {
  const key = (x: AIAction): string =>
    JSON.stringify([x.against ?? 'dom', x.condition ?? '', x.expected ?? null, x.description ?? '', x.frame ?? null]);
  return key(a) === key(b);
}

/**
 * Does what a check read already hold its expected text — spacing collapsed,
 * letter case aside? Then the check most likely read the right part of the
 * page and failed on something else there (another payee listed, say, or the
 * letter case itself), and its failure does not say where else the text is
 * (SPEC-web-survey-fixes.md §2.25): a retry that plans the step again could
 * take it as an invitation to a weaker check — say, "Order Shipped" in a help
 * text for a status that says "Order shipped", or a list shown in capitals by
 * CSS read as shown. A re-check of the same check is never told where
 * ({@link FailedCheck.failure}). It is a trade-off: the failure of a check
 * that read the wrong element, whose text differs from the expected only in
 * letter case, does not say where either. What a check read is its code's
 * `actual` — as a rule what it read, or "element not found: …" when it found
 * nothing, as the code prompt asks: that holds nothing, whatever its selector
 * quotes.
 *
 * Letter case is set aside by comparing the two in lower case and in upper
 * case, either matching, as src/browser/locate-text.ts compares a text in the
 * case it is shown in: upper-casing can change a text's length —
 * "HAUPTSTRASSE 5" holds "Hauptstraße 5" in upper case, not in lower.
 */
export function readHoldsExpected(read: string, expected: string | undefined): boolean {
  if (expected === undefined) return false;
  if (/^element not found\b/i.test(read.trim())) return false;
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const want = norm(expected);
  if (want === '') return false;
  const got = norm(read);
  return got.toLowerCase().includes(want.toLowerCase()) || got.toUpperCase().includes(want.toUpperCase());
}

/**
 * The failed check's own code, for its re-check to run again as it is — or
 * `undefined` when the re-check writes new code: when that code found no
 * element (it said "element not found: …", as the code prompt asks), when
 * there is no code to run, or when the re-check's condition or expected value
 * (`now`, placeholders resolved again) is not what the code was written for —
 * a value read again before the re-check can differ, and the code holds the
 * old one ({@link FailedCheck.resolved}). The code given back may still not
 * run: `evaluateAssertion` (step-executor.ts) writes it anew when it would
 * change the page, and when it breaks on running again.
 * After a re-check that came to no verdict, the check carried forward still
 * holds the code that came back false ({@link FailedCheck.noVerdict}), and it
 * is run again too: what ended that attempt may not have been the code.
 *
 * The same code sees the page as it is now, and cannot read it another way.
 * Asked for new code after the old code had read the page and answered, the
 * code AI wrote code that read the whole page's `innerText`, which in Chrome
 * holds every option of a dropdown, and passed a check that must fail in 3 of
 * 9 runs (SPEC-verify-checks.md, section 11, T).
 *
 * Only the condition and the expected value are compared: the code holds
 * them. A `frame` that resolves to another frame than before is not noticed.
 */
export function codeToRunAgain(
  check: Pick<FailedCheck, 'read' | 'code' | 'resolved'>,
  now: FailedCheck['resolved'],
): string | undefined {
  if (check.code === undefined || check.code.trim() === '') return undefined;
  if (check.resolved.condition !== now.condition || check.resolved.expected !== now.expected) return undefined;
  return /^element not found\b/i.test(check.read.trim()) ? undefined : check.code;
}

/** The longest code, and the longest read, quoted back to the code AI. */
const MAX_CODE_CHARS = 2000;
const MAX_READ_CHARS = 500;

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One earlier failure of a check, as {@link recheckNote} quotes it. */
export interface PriorCheck {
  /** How it failed, without where the expected text is ({@link FailedCheck.failure}). */
  error: string;
  read: string;
  code?: string | undefined;
  /** Set when this was a re-check that came to no verdict: why ({@link FailedCheck.noVerdict}). */
  noVerdict?: string | undefined;
}

/** What a check reads: the page, API responses, either, or nothing but its condition. */
export type CheckKind = NonNullable<AIAction['against']>;

/** The re-check's first instruction: keep the question, all of it. */
const keepTheQuestion = (given: string): string =>
  `Write the code for this check again, for ${given} given above. Check everything the condition says, and drop ` +
  'no part of it — not "only", "no other", "all", "exactly", a count, a "not", or whether letter case counts.';

/**
 * What the code AI is told when it writes a failed check's code again: the
 * check is the same, only how its code reads and compares may change — worded
 * for what a check of its `kind` reads, as its code prompt is
 * (`buildAssertionCodePrompt`). A page check is told to read the part of the
 * page its condition names; an `api` check, to take the value its condition
 * names from the API responses; one that may do either (`both`), to read the
 * part of the page or take the value from the API responses that its
 * condition names; a `predicate`, which has no expected value, to evaluate
 * its condition as written, reading nothing.
 */
export function recheckNote(failures: readonly PriorCheck[], kind: CheckKind = 'dom'): string {
  const lines: string[] = ['An earlier attempt at this check failed:'];
  for (const f of failures) {
    if (f.noVerdict !== undefined) {
      // The failure above, asked again: its error, read and code are the same.
      lines.push(`- Asked again, it came to no verdict: ${cap(f.noVerdict, MAX_READ_CHARS * 2)}`);
      continue;
    }
    // The error quotes what was read too, so it is capped as well, at twice
    // the read's cap: it says what was expected besides.
    lines.push(`- ${cap(f.error, MAX_READ_CHARS * 2)}`);
    // A predicate's code reads nothing: what it returns says what it compared.
    lines.push(`  ${kind === 'predicate' ? 'Its code reported' : 'Its code read'}: ${JSON.stringify(cap(f.read, MAX_READ_CHARS))}`);
    if (f.code !== undefined && f.code.trim() !== '') {
      lines.push(`  Its code: ${cap(f.code, MAX_CODE_CHARS)}`);
    }
  }
  if (kind === 'predicate') {
    lines.push(
      keepTheQuestion('the condition'),
      'Both sides of the comparison are in the condition, so read nothing from the page or from API responses: ' +
        'evaluate the condition as it is written. If that code evaluated something else, evaluate what the ' +
        'condition says.',
    );
  } else if (kind === 'api') {
    lines.push(
      keepTheQuestion('the condition and the expected value'),
      'Take the value the condition names from the API responses, not wherever the expected text appears in them. ' +
        'If that code took another value, or found none, take the one the condition names. If it took that one, ' +
        'compare it again as the requirements above say: that value decides the check.',
    );
  } else if (kind === 'both') {
    lines.push(
      keepTheQuestion('the condition and the expected value'),
      'Read the part of the page, or take the value from the API responses, that the condition names, not ' +
        'wherever the expected text appears. If that code read another part or took another value, or found ' +
        'nothing, read the part or take the value the condition names: use a different selector, or JavaScript ' +
        'that works. If it read that part or took that value, read or take it again and compare it as the ' +
        'requirements above say, searching nowhere else on the page or in the API responses for the text. What ' +
        'that part or value holds decides the check. (Reading `window.__steptixNotices` for a notification that ' +
        'closes by itself, as the requirements say, is not such a search.)',
    );
  } else {
    lines.push(
      keepTheQuestion('the condition and the expected value'),
      'Read the part of the page the condition names, not wherever the expected text appears. If that code read ' +
        'another part, or found nothing, read the part the condition names: use a different selector, or ' +
        'JavaScript that works. If it read that part, read it again and compare it as the requirements above say, ' +
        'searching nowhere else on the page for the text. What that part holds decides the check. (Reading ' +
        '`window.__steptixNotices` for a notification that closes by itself, as the requirements say, is not such ' +
        'a search.)',
    );
  }
  return lines.join('\n');
}

/**
 * The earlier failures that still stand, for a retry that plans the step
 * again: what its step AI is told (`buildRetryContext`), and
 * {@link earlierCheckErrors}. Left out is every failure of a check a re-check
 * later passed: it no longer stands, and being told it would steer the new
 * plan away from what passed. A check last recorded in attempt `k` of a step
 * that re-checks (`rechecks`: not an `If …, then return / stop / fail` line)
 * was asked again in attempt `k + 1`, which would have recorded it again had
 * the re-check not passed.
 */
export function standingFailures(
  failures: readonly PriorFailureContext[],
  attemptNumber: number,
  rechecks: boolean,
): PriorFailureContext[] {
  if (!rechecks) return [...failures];
  const lastRecorded = (c: FailedCheck): number =>
    Math.max(...failures.flatMap((g) => (g.check !== undefined && sameCheck(g.check.action, c.action) ? [g.check.attempt] : [])));
  return failures.filter((f) => f.check === undefined || lastRecorded(f.check) + 1 >= attemptNumber);
}

/**
 * The errors of this step's earlier checks that still stand
 * ({@link standingFailures}), each once, for {@link earlierFailuresNote}.
 */
export function earlierCheckErrors(
  failures: readonly PriorFailureContext[],
  attemptNumber: number,
  rechecks: boolean,
): string[] {
  return [...new Set(
    standingFailures(failures, attemptNumber, rechecks).filter((f) => f.actionType === 'assert').map((f) => f.error),
  )];
}

/**
 * What the code AI of a check the step AI wrote anew on a retry is told —
 * on a retry that does not re-check (an `If …, then return / stop / fail`
 * line, a first check whose code failed, or a failure that was not a check
 * and did not end a re-check): how this step's checks failed before, with
 * where the expected text is when it was found (SPEC-web-survey-fixes.md
 * §2.25), as before. The check may ask something else, so it is not told to
 * keep one.
 */
export function earlierFailuresNote(errors: readonly string[]): string {
  return (
    `An earlier attempt at this check failed:\n${errors.map((e) => `- ${cap(e, MAX_READ_CHARS * 2)}`).join('\n')}\n` +
    'Do not read the same element again unless it really is what the step means.'
  );
}

/**
 * What the code AI of a re-checked check is told when the code it wrote would
 * have changed the page — `call` is what in it would have. `ranBefore`: the
 * code is the failed check's own, which ran in the attempt before (a first
 * check's code is not scanned) and is not run again.
 */
export function checkCodeReadsOnly(call: string, ranBefore = false): string {
  return (
    `That code would change the page (\`${call}\`), ${ranBefore ? 'so it is not run again' : 'and was not run'}. ` +
    'A check only reads the page and compares: ' +
    'write it again without clicking, typing, focusing, scrolling, dispatching events or changing the DOM. To leave ' +
    'part of an element out of its text, read the text of the parts you want rather than removing the rest from a copy.'
  );
}
