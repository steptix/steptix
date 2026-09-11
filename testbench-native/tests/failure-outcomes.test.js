/**
 * The two failure OUTCOMES on the client
 * (stories/step-failure-outcomes.md, decisions 2 and 6).
 *
 * Every string here is user-visible and unreadable from the extension host once
 * it is rendered — a gutter hover, an output-channel line, the after-text on
 * `## Steps` — so the logic lives in pure `*-core.ts` modules and this suite is
 * the only thing pinning the wording and the precedence.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deliberateRunLogLine,
  deliberateTestOutputLine,
  passPaintsOver,
  toleratedPaintsOver,
  toleratedRunLogLine,
  toleratedTestOutputLine,
} from '../src/extension/failure-outcome-core.ts';
import {
  DELIBERATE_HOVER_OPENING,
  DELIBERATE_TOLERATED_BODY,
  failHoverMessage,
  TOLERATED_HOVER_OPENING,
  toleratedHoverMessage,
} from '../src/extension/failure-hover-core.ts';
import { describeStepFailure } from '../src/../../runner-core/src/protocol.ts';
import {
  countMainFlowStatuses,
  runLogTallyLine,
  stepsSummaryText,
} from '../src/extension/steps-summary-core.ts';
import { compileResultLine, partialNotes } from '../src/extension/compile-summary-core.ts';

const CB = { file: '/p/tests/booking.steps.ts', error: 'locator resolved to 2 elements' };
const WARNING = 'No peanuts on the dashboard';
/** The author's own sentence on the live fixture's `fail` step. */
const PEANUTS = 'The variable value was peanuts. Expected apples';
/** A hover's body: the error, fenced, exactly as the renderers write it. */
const fenced = (s) => `\`\`\`\n${s}\n\`\`\``;

// ── Paint precedence ───────────────────────────────────────────────────────

test('a tolerated failure paints over anything except a real ✗', () => {
  // Decision 6, as `skipPaintsOver`: a failure is the one status a run must not lose.
  assert.equal(toleratedPaintsOver(undefined), true);
  assert.equal(toleratedPaintsOver('pass'), true);
  assert.equal(toleratedPaintsOver('running'), true);
  assert.equal(toleratedPaintsOver('skip'), true);
  assert.equal(toleratedPaintsOver('fail-tolerated'), true);
  assert.equal(toleratedPaintsOver('fail'), false);
});

test('a later pass does not repaint an amber ✗ green', () => {
  // Decision 6's asymmetry: the run carrying on is the point of the tail, so a later
  // pass on the same line is the NORMAL case and must not erase the mark.
  assert.equal(passPaintsOver('fail-tolerated'), false);
  assert.equal(passPaintsOver(undefined), true);
  assert.equal(passPaintsOver('pass'), true);
  assert.equal(passPaintsOver('skip'), true);
  // Deliberately NOT protected — that behaviour predates this story.
  assert.equal(passPaintsOver('fail'), true);
});

// ── Hover ──────────────────────────────────────────────────────────────────

test('the amber ✗ hover opens by naming the tail, then fences the error', () => {
  const hover = toleratedHoverMessage({ error: WARNING });
  assert.equal(hover, `${TOLERATED_HOVER_OPENING}\n\n${fenced(WARNING)}`);
  // An amber ✗ on a green run reads as a tool bug until something names the tail.
  assert.match(hover, /otherwise continue/);
});

test('a tolerated failure out of a code-behind entry still says so', () => {
  const hover = toleratedHoverMessage({ error: 'expected "Dashboard"', fromCodeBehind: true });
  assert.ok(hover.startsWith(TOLERATED_HOVER_OPENING));
  assert.match(hover, /Its code-behind failed/);
  assert.match(hover, /expected "Dashboard"/);
});

test('a tolerated failure after a heal names BOTH errors', () => {
  // A broken entry whose AI attempt also failed, then tolerated: dropping the crash
  // hides it on exactly the runs nobody looks at twice.
  const hover = toleratedHoverMessage({ error: 'still no build number', codeBehindStale: CB });
  assert.ok(hover.startsWith(TOLERATED_HOVER_OPENING));
  assert.match(hover, /locator resolved to 2 elements/);
  assert.match(hover, /still no build number/);
  assert.match(hover, /booking\.steps\.ts/);
});

test('with no warning the hover is byte-identical to what it always was', () => {
  assert.equal(toleratedHoverMessage({ error: 'x' }), `${TOLERATED_HOVER_OPENING}\n\n${fenced('x')}`);
});

test('the hover clips like the fail hover does', () => {
  // Same bound, because the same Playwright call log can land on either.
  const hover = toleratedHoverMessage({ error: 'x'.repeat(5000) });
  assert.ok(hover.length < 1200, `hover was ${hover.length} chars`);
  assert.match(hover, /…/);
});

// Decision 6: the author's warning leads every flavour of amber hover — it answers
// "why was this survivable", which the framework's error cannot — and the sentence
// naming the tail, the code-behind aside and the deliberate body keep their place.
const WARNING_LEADS = [
  ['a plain one', { error: 'the title did not contain "Peanuts"' }, /otherwise continue/],
  ['one out of a code-behind entry', { error: 'expected "Dashboard"', fromCodeBehind: true }, /Its code-behind failed/],
  ['a deliberate one', { error: 'The cart was empty', deliberate: true, fromCodeBehind: true }, new RegExp(DELIBERATE_TOLERATED_BODY)],
];
for (const [flavour, failure, alsoSays] of WARNING_LEADS) {
  test(`the author’s warning is the hover’s FIRST line — ${flavour}`, () => {
    const hover = toleratedHoverMessage({ ...failure, warning: WARNING });
    assert.ok(hover.startsWith(`${WARNING}\n\n`), `warning must lead; got:\n${hover}`);
    assert.match(hover, alsoSays);
    assert.ok(hover.includes(failure.error), `the framework's account must survive; got:\n${hover}`);
  });
}

// ── A DELIBERATE failure is not a broken entry ─────────────────────────────

test('a compiled deliberate failure is not framed as a code defect', () => {
  // Decision 2: `step.fail()` throws what a failed `step.expect` throws, so a COMPILED
  // deliberate failure arrives `fromCodeBehind` — and the ordinary wording put "This
  // step's code-behind failed:" over the author's own sentence.
  const hover = failHoverMessage({ error: PEANUTS, fromCodeBehind: true, deliberate: true });
  assert.ok(hover.startsWith(DELIBERATE_HOVER_OPENING));
  assert.doesNotMatch(hover, /code-behind failed/);
  // The fact is kept: it is true, and it says the message cost no tokens.
  assert.match(hover, /via its code-behind/);
  assert.match(hover, /The variable value was peanuts/);
});

test('an AI-run deliberate failure says the same thing, without the aside', () => {
  const hover = failHoverMessage({ error: PEANUTS, deliberate: true });
  assert.equal(hover, `${DELIBERATE_HOVER_OPENING}\n\n${fenced(PEANUTS)}`);
});

test('an ordinary code-behind failure is unchanged', () => {
  // The control: nothing above may quieten a REAL entry defect.
  assert.equal(
    failHoverMessage({ error: 'boom', fromCodeBehind: true }),
    `This step's code-behind failed:\n\n${fenced('boom')}`,
  );
});

test('the single-line surfaces stop accusing the entry too', () => {
  // `describeStepFailure` feeds the run log, Test Explorer and the compile fold, and
  // `(in its code-behind)` sends a reader hunting a bug that is not there.
  assert.equal(
    describeStepFailure({ error: PEANUTS, fromCodeBehind: true, deliberate: true }),
    PEANUTS,
  );
  // Unchanged without the flag.
  assert.equal(describeStepFailure({ error: 'boom', fromCodeBehind: true }), 'boom (in its code-behind)');
});

// ── Log lines ──────────────────────────────────────────────────────────────

test('the run log says the run continued, in the ⚠ the gutter paints', () => {
  assert.equal(toleratedRunLogLine(7, WARNING), `⚠ step 7 failed — continuing: ${WARNING}`);
});

test('the run log leads with the author’s warning when the tail carried one', () => {
  // Decision 9: before the field, the warning travelled only in the report row's
  // explanation, which no wire event carries.
  assert.equal(
    toleratedRunLogLine(7, 'the title did not contain "Peanuts"', WARNING),
    `⚠ step 7 failed — continuing: ${WARNING} (the title did not contain "Peanuts")`,
  );
  // An empty warning is no warning: no stray brackets, no dangling colon.
  assert.equal(
    toleratedRunLogLine(7, 'banner not shown', ''),
    '⚠ step 7 failed — continuing: banner not shown',
  );
});

test('a deliberate failure says the message is the author’s', () => {
  assert.equal(deliberateRunLogLine(9, PEANUTS), `✗ step 9 failed as written: ${PEANUTS}`);
});

test('Test Explorer names the file when the step is not in this test', () => {
  assert.equal(
    toleratedTestOutputLine(4, ' of login.md', 'banner not shown'),
    '⚠ step on line 4 of login.md failed — continuing: banner not shown',
  );
  assert.equal(
    deliberateTestOutputLine(4, '', 'no balance was shown'),
    '✗ step on line 4 failed as written: no balance was shown',
  );
});

// ── Counting: the `## Steps` after-text and the run log's closing tally ────

/** Lines 1..n as the main flow, and a status per line. */
const summaryOf = (...statuses) =>
  countMainFlowStatuses(
    statuses.map((s, i) => [i + 1, s]),
    statuses.map((_, i) => i + 1),
  );

/** A run's counters, with every one a case does not name left at zero. */
const tally = (over) =>
  runLogTallyLine({ passed: 0, skipped: 0, tolerated: 0, cached: 0, codeBehind: 0, stale: 0, ...over });

test('a tolerated step is counted as neither a pass nor a skip', () => {
  const counts = summaryOf('pass', 'fail-tolerated', 'pass');
  assert.equal(counts.passed, 2, 'it did not do its work, so it is not a pass');
  assert.equal(counts.skipped, 0, 'it RAN — it is not a skip either');
  assert.equal(counts.tolerated, 1);
  assert.equal(counts.total, 3);
});

test('the heading summary names it, so the denominator stops swallowing it', () => {
  assert.equal(stepsSummaryText(summaryOf('pass', 'fail-tolerated', 'pass')), '2/3 passed, 1 tolerated');
});

test('skipped and tolerated read as two clauses, in that order', () => {
  assert.equal(
    stepsSummaryText(summaryOf('pass', 'skip', 'fail-tolerated')),
    '1/3 passed, 1 skipped, 1 tolerated',
  );
});

test('a run with no tolerated step renders the byte-identical string it always did', () => {
  assert.equal(stepsSummaryText(summaryOf('pass', 'pass')), '2/2 passed');
  assert.equal(stepsSummaryText(summaryOf('pass', 'skip')), '1/2 passed, 1 skipped');
});

test('the run log tally names it too', () => {
  assert.equal(tally({ passed: 7, tolerated: 1 }), '✓ 7 passed, 1 tolerated');
  assert.equal(
    tally({ passed: 7, skipped: 2, tolerated: 1, codeBehind: 3 }),
    '✓ 7 passed (3 code-behind), 2 skipped, 1 tolerated',
  );
  // And a run that tolerated nothing is unchanged.
  assert.equal(tally({ passed: 7 }), '✓ 7 passed');
});

// ── What a compile SAYS about a run its own text ended ─────────────────────
// (stories/step-failure-outcomes.md §"What the compile showed")

/** A compile summary with only the fields these two renderers read. */
const compileSummary = (over = {}) => ({
  test: 'C:/p/tests/failure-outcomes-live.md',
  totalSteps: 10,
  compiled: 7,
  kept: 0,
  keptAi: 0,
  rounds: 0,
  tokensUsed: 0,
  written: [],
  unproven: [],
  writtenOffAi: [],
  notAttempted: [],
  recordingDir: 'C:/p/tests/.aiui-codebehind-cache/failure-outcomes-live.recording',
  ...over,
});

/** A `compile:result` frame as the wire sends it, with only the summary varying. */
const resultLine = (status, over = {}) =>
  compileResultLine({ type: 'compile:result', status, files: {}, summary: compileSummary(over) });

/** Partial-compile notes, with the list fields a case does not name left empty. */
const notesFor = (over) =>
  partialNotes({ notAttempted: [], writtenOffAi: [], unproven: [], ...over });

const ENDED = {
  step: 9,
  error: PEANUTS,
  line: `If {{a}} is "peanuts" then fail the test with error "${PEANUTS}"`,
};

test('the compile log line says the run ENDED, with no "failed under AI" in it', () => {
  const line = resultLine('partial', { endedAsWritten: ENDED, notAttempted: [10] });
  assert.match(line, /ended at step 9 as its text says — The variable value was peanuts\. Expected apples/);
  assert.match(line, /1 step\(s\) not attempted/);
  // The two phrases that sent an author to repair a working step.
  assert.doesNotMatch(line, /failed under AI/);
  assert.doesNotMatch(line, /stopped at step/);
});

test('a stopped run still says stopped — the fix narrows, it does not replace', () => {
  const line = resultLine('partial', {
    stoppedAt: { step: 2, error: '"Add to cart" button not found' },
    notAttempted: [3],
  });
  assert.match(line, /stopped at step 2 — "Add to cart" button not found/);
  assert.doesNotMatch(line, /as its text says/);
});

test('a compile that produced nothing because the run ended says so without a ✗', () => {
  const line = resultLine('partial', {
    compiled: 0,
    keptAi: 0,
    endedAsWritten: { ...ENDED, step: 1 },
    notAttempted: [2, 3],
  });
  assert.match(line, /^◐ Compiled nothing in failure-outcomes-live\.md: ended at step 1 as its text says/);
  assert.match(line, /\(2 step\(s\) not attempted\)\./);
  // Not the other nothing-came-of-it line ("the run stopped before any step produced
  // an entry"), which is false about this run.
  assert.doesNotMatch(line, /the run stopped/);
});

test('never says "Compiled nothing" over a GREEN compile', () => {
  // `green` says nothing was owed and "Compiled nothing" is a complaint, so the two
  // cannot share a line. The renderer's half of the §"What the compile showed" fix.
  const line = resultLine('green', { compiled: 0, keptAi: 0, endedAsWritten: { ...ENDED, step: 1 } });
  assert.match(line, /^✓ Nothing to compile in failure-outcomes-live\.md/);
  assert.doesNotMatch(line, /Compiled nothing/);
  // The ending is still reported — it is the run's own news, not a complaint.
  assert.match(line, /ended at step 1 as its text says/);
  // A green compile with nothing left over is the sentence it always was.
  assert.equal(
    resultLine('green', { compiled: 0, keptAi: 0 }),
    '✓ Nothing to compile in failure-outcomes-live.md — every step already has code-behind.',
  );
  // And one that never reached some steps does not claim they have code.
  assert.match(
    resultLine('green', { compiled: 0, keptAi: 0, notAttempted: [4, 5] }),
    /^✓ Nothing to compile in failure-outcomes-live\.md — no step needed an entry \(2 step\(s\) not attempted\)\.$/,
  );
});

test('a stopped compile that produced nothing still gets its ✗ line', () => {
  // The narrowing is about `green` only — a failed compile says it in the old words.
  assert.match(
    resultLine('failed', { compiled: 0, keptAi: 0, notAttempted: [2, 3] }),
    /^✗ Compiled nothing in failure-outcomes-live\.md: the run stopped before any step produced an entry \(2 step\(s\) not attempted\)\.$/,
  );
});

test('the partial-compile notes name the ending step, the unrun steps, and no repair', () => {
  const notes = notesFor({ endedAsWritten: ENDED, notAttempted: [10] });
  assert.equal(
    notes,
    ` Ended at step 9 as its text says — ${PEANUTS}.` +
      ' Step 10 not attempted — a run that does not end there compiles the rest.',
  );
  assert.doesNotMatch(notes, /Fix it/);
  assert.doesNotMatch(notes, /failed under AI/);
});

test('the notes drop the unrun clause when the ending step was the last', () => {
  assert.equal(notesFor({ endedAsWritten: ENDED }), ` Ended at step 9 as its text says — ${PEANUTS}.`);
});

test('a stopped compile keeps the sentence it always had, repair advice and all', () => {
  assert.equal(
    notesFor({ stoppedAt: { step: 2, error: 'no such button' }, notAttempted: [3, 4] }),
    ' Step 2 failed under AI — no such button. Steps 3–4 not attempted.' +
      ' Fix it, run, and compile again for the rest.',
  );
});

// ── Both flags at once: a deliberate failure the tail tolerated ────────────

test('an amber ✗ over a step.fail() does not accuse the entry of being broken', () => {
  // Decisions 2 and 6 composing: a hand-written `step.fail()` in the entry of a step
  // whose line carries `otherwise continue`. The amber hover was the surface not told.
  const hover = toleratedHoverMessage({
    error: 'The cart was empty and this page needs it filled',
    tolerated: true,
    deliberate: true,
    fromCodeBehind: true,
  });
  assert.ok(hover.startsWith(TOLERATED_HOVER_OPENING), `got:\n${hover}`);
  assert.match(hover, new RegExp(DELIBERATE_TOLERATED_BODY));
  assert.doesNotMatch(hover, /Its code-behind failed/);
  // The code-behind fact is kept — it is just no longer an accusation.
  assert.match(hover, /via its code-behind/);
  assert.match(hover, /The cart was empty/);
});

test('a deliberate tolerated failure with no entry behind it drops the aside', () => {
  assert.equal(
    toleratedHoverMessage({ error: 'as written', deliberate: true }),
    `${TOLERATED_HOVER_OPENING}\n\n${DELIBERATE_TOLERATED_BODY}:\n\n${fenced('as written')}`,
  );
});
