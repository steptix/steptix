import { basename } from 'node:path';
import type { AiClient } from '../ai/client.js';
import type { ChatMessage } from '../ai/types.js';
import {
  decodeDoubleEscapedNewlines,
  extractJson,
  findInlinedParameterValue,
} from '../ai/action-parser.js';
import { isReturnClaim, parseFlowControlStep } from '../parser/flow-control-step.js';
import { parseFailureTail } from '../parser/failure-tail.js';
import type { Candidate } from './candidate.js';
import { conditionEntryComplaint, describeGuardedName, entryDefinesCondition } from './generate.js';
import { listEntries, validateCodeBehindSource } from './writer.js';

/**
 * The compiler's review pass (stories/codebehind-compile.md, "Review").
 *
 * One model call over the *complete* candidate file, against a checklist.
 * The characteristic bug of this feature — a model freezing today's date as a
 * literal — produces code that passes on the day it is written, so replay
 * cannot catch it. Only a reader asking "should this have been computed?" can.
 */

export interface FileReviewInput {
  /** Basename of the markdown this code-behind belongs to, for orientation. */
  markdownName: string;
  /** The candidate file, complete. */
  file: string;
  /** The test's steps, in order, so the reviewer can see what each entry is for. */
  steps: string[];
}

/** A `condition` function in an entry — `async condition({ … })` or
 *  `condition: async (…) =>` — the shape a condition line's entry has. */
const CONDITION_ENTRY = /\bcondition\s*(?:\(|:\s*(?:async\b|\())/;

export function buildFileReviewPrompt(input: FileReviewInput): ChatMessage {
  const stepBlock = input.steps.length === 0
    ? '(step list unavailable)'
    : input.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  // The post-condition rule's one exception (stories/step-flow-control.md,
  // decision 11; stories/step-failure-outcomes.md, decision 10). Emitted only when a
  // step in this test actually claims the form, so a reviewer that has never seen a
  // `step.exit()` is not invited to add post-conditions to entries that must not
  // have one.
  const claims = input.steps
    .map((s) => parseFlowControlStep(s))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  // The `fail` half is named only when a `fail` step is in the test, for the reason
  // the whole block is gated: a reviewer told about `step.fail` over a test that has
  // none is invited to invent one.
  const failException = claims.some((c) => !isReturnClaim(c))
    ? " The same holds for a step that ends `then fail the test with error \"…\"`: its entry is\n" +
      "   an `if (…) step.fail('…');`, `step.fail` throws too, and an entry that is that and\n" +
      '   nothing else is complete.'
    : '';
  const flowControlException = claims.length > 0
    ? ' The one exception is a **flow-control step** — one whose text ends `then return` or\n' +
      '   `then stop`. Its entry evaluates the condition and calls `step.exit()` when it holds;\n' +
      '   `step.exit()` throws, so there is nothing after it to assert on. An entry that is an\n' +
      `   \`if (…) step.exit();\` and nothing else is complete: leave it alone.${failException}`
    : '';

  // The `otherwise …` tails (stories/step-failure-outcomes.md, decisions 5 and 6).
  // Gated per form, and numbered from 10 so the checklist reads as one list: a test
  // with no tail is reviewed against exactly the nine items it was before.
  const tails = input.steps
    .map((s) => parseFailureTail(s))
    .filter((t): t is NonNullable<typeof t> => t !== null);
  const tailRules: string[] = [];
  if (tails.some((t) => t.outcome === 'fail' && t.message !== undefined)) {
    tailRules.push(
      '**A step that ends `otherwise fail … with message "M"` keeps M, verbatim.** The\n' +
        "   author's sentence is what the report, the hover and the run summary lead with, so\n" +
        '   it is the message of that entry\'s `step.expect(…)`. Do not reword it, shorten it or\n' +
        '   "improve" it into a description of what the code compares — the comparison is\n' +
        '   already visible in the code.',
    );
  }
  if (tails.some((t) => t.outcome === 'continue')) {
    tailRules.push(
      '**A step that ends `otherwise continue` is reviewed as its body alone.** The tail\n' +
        '   decides what the RUNNER does once the step has failed; it says nothing about what\n' +
        '   the entry should do. Review the body as an ordinary step, and do not soften its\n' +
        '   assertions because the failure is tolerated.',
    );
  }
  // Condition entries (stories/codebehind-loops-and-conditions.md, "Generation":
  // "The review pass is told condition entries exist"). Gated on the FILE, not
  // the steps: a test full of `If` lines whose conditions are decided from
  // their values has none, and a reviewer told about a kind of entry the file
  // does not hold is invited to write one.
  const hasConditionEntry = CONDITION_ENTRY.test(input.file);
  if (hasConditionEntry) {
    tailRules.push(
      '**A `condition` entry answers a condition line** (`If`, `Else if`, `While`, `Repeat …\n' +
        '   until`): `async condition({ page, step })` returning `true` or `false` for whether the\n' +
        '   condition, as written, holds on the page now. Keep it a condition that returns a boolean.\n' +
        '   Keep it read-only — no click, fill, press, check, select, navigation, keyboard or mouse —\n' +
        '   and give it no waits: the framework has already settled the page before it asks. Never\n' +
        '   turn one into a `run` entry, never give an entry both, and never add a `condition` entry\n' +
        '   for a line that has none. A `Repeat … until` entry answers whether its until-condition\n' +
        '   holds (true ends the loop) — do not invert it.',
    );
  }
  const tailBlock =
    tailRules.length === 0 ? '' : `\n${tailRules.map((r, i) => `${10 + i}. ${r}`).join('\n')}`;
  // Rule 3 asks every entry for a post-condition; a condition entry has none —
  // it ends with its `return`.
  const conditionException = hasConditionEntry
    ? ' A `condition` entry takes no post-condition: it answers true or false and ends with its\n' +
      '   `return` — never add one to it.'
    : '';

  return {
    role: 'user',
    content: `Review a generated Playwright code-behind file before it is committed.

Each entry in the file replaces one natural-language test step. The file runs
with no model call, on every future run, possibly for years.

## The test's steps
${stepBlock}

## The file, as generated
\`\`\`ts
${input.file}
\`\`\`

## The checklist

1. **Dynamic values are computed at runtime, not frozen.** A date, a derived
   code, a formatted number the step describes as a computation must be worked
   out in the code. A literal that was correct on the day of generation and
   wrong the next day is the single worst defect this file can carry — look for
   it first.
2. **Parameters are read via \`step.getVar('name')\`**, never inlined as
   literals.
3. **Every entry ends with a post-condition** — a \`locator.waitFor()\` on what
   the step produced, or a \`step.expect(...)\` over a value read back from the
   page — so "did not throw" means "the step worked".${flowControlException}${conditionException}
4. **Captures are written**: a step with \`[as: x]\` must call
   \`step.setVar('x', ...)\`.
5. **Stable selectors** (ids, \`data-testid\`, roles, labels) over positional
   or index-based ones.
6. **No imports** beyond the file's existing \`defineSteps\` import, and no
   \`page.waitForTimeout\` unless it is genuinely unavoidable.
7. Leave \`source\` strings and \`section\` fields **exactly** as they are —
   they are how entries bind to steps, and an edit silently unbinds one. Never
   remove an entry, and **never add one**: a step with no entry is one the
   compile chose not to generate for, or has no recording of, and code written
   for it without a recording is a guess. The set of entries you return must
   be exactly the set you were given.
8. **Upload paths go through \`step.filePath('…')\`** — never a bare string
   literal handed to \`setInputFiles\`/\`setFiles\`, and never an absolute path. A
   path in a step is relative to the test file's folder, and only
   \`step.filePath\` resolves it that way at replay time.
9. An \`ai: true\` entry is a decision, not an omission: leave it alone,
   comment included. Do not turn one into a \`run\` entry, however obvious the
   code looks — something already established that this step needs the model.${tailBlock}

## What to return

The complete revised file — not a diff, not a fragment — as one JSON string
field (standard JSON string encoding):

{
  "file": "// Generated by ai-ui-automation …\\nimport { defineSteps } …"
}

If nothing needs changing, return the file unchanged. Respond with ONLY the
JSON object — no prose around it.`,
  };
}

/**
 * Pull the revised file out of the `{"file": "..."}` envelope.
 *
 * Same double-escape decoding as the entry envelope: a model that writes
 * `\\n` inside the string leaves literal backslash-n in code position, which
 * can only ever be a syntax error.
 */
export function parseFileRevision(rawResponse: string): string {
  let body: string | undefined;
  try {
    const parsed: unknown = JSON.parse(extractJson(rawResponse));
    if (typeof parsed === 'object' && parsed !== null) {
      const file = (parsed as Record<string, unknown>)['file'];
      if (typeof file === 'string' && file.trim()) body = decodeDoubleEscapedNewlines(file);
    }
  } catch {
    // Not JSON — fall through to the fence path below.
  }

  if (body === undefined) {
    const fenced = /```(?:ts|typescript)?\s*\n([\s\S]*?)```/i.exec(rawResponse);
    if (fenced?.[1]) body = fenced[1];
  }

  const text = body?.trim();
  if (!text) throw new Error('Review response carried no revised file');
  if (!/\bdefineSteps\s*\(/.test(text)) {
    throw new Error('Review response is not a code-behind file (no `defineSteps(` call)');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** What a review pass needs to know about the compile it is reviewing. */
export interface ReviewCandidateInput {
  /** Basename of the markdown this code-behind belongs to, for orientation. */
  markdownName: string;
  /** The test's authored step texts, in order — what every `source` matches. */
  steps: string[];
  /**
   * Every value the revision must not inline: the resolved parameters and the
   * resolved environment references. Deliberately broad — a whole-file rewrite
   * can move a literal into any entry, so the check has to cover them all.
   */
  guarded: Array<{ name: string; value: string }>;
  aiClient: AiClient;
  signal?: AbortSignal | undefined;
}

/**
 * The review pass. Non-fatal by construction: a revision that will not compile,
 * or that smuggles a parameter value in, is discarded and the pre-review
 * candidate stands.
 *
 * Shared by the boxed pipeline (`compileTest`) and the live one
 * (stories/compile-as-you-go.md, the Run & Compile path). `emit` receives the
 * phase message; the caller decides what frame it becomes.
 */
export async function reviewCandidate(
  candidate: Candidate,
  input: ReviewCandidateInput,
  emit: (message: string) => void,
  /** Which of the candidate's files to review. Defaults to all of them; the
   *  live path narrows it to the ones a block actually changed, so a run split
   *  across several requests does not re-review what it already passed. */
  files: string[] = candidate.touchedFiles(),
): Promise<void> {
  for (const file of files) {
    const before = candidate.contentOf(file);
    if (before === undefined) continue;
    // Before the call, not after (stories/compile-tail-progress.md). Review is
    // the longest single model call the compile makes and its first word used
    // to arrive only once it had finished — the quietest stretch of the tail
    // saying nothing at all about what it was doing.
    emit(`reviewing ${basename(file)}…`);
    let revised: string;
    try {
      const completion = await input.aiClient.complete(
        [
          buildFileReviewPrompt({
            markdownName: input.markdownName,
            file: before,
            steps: input.steps,
          }),
        ],
        input.signal,
        { profile: 'authoring' },
      );
      revised = parseFileRevision(completion.text);
    } catch (err) {
      emit(`skipped for ${basename(file)} (${(err as Error).message}) — the generated file stands`);
      continue;
    }

    if (revised.trim() === before.trim()) {
      emit(`no changes to ${basename(file)}`);
      continue;
    }

    const leaked = findInlinedParameterValue(revised, input.guarded);
    if (leaked) {
      emit(`rejected: the revision inlines ${describeGuardedName(leaked)} — the generated file stands`);
      continue;
    }
    // The reviewer edits entries; it does not decide which steps have one.
    // Caught live: given the whole test, it wrote an entry for the step a
    // prefix compile had deliberately left alone — code for a step nobody
    // recorded, which the next compile would then skip as "already has one".
    const entriesBefore = listEntries(before);
    const entriesAfter = listEntries(revised);
    const entriesChanged = describeEntryChange(entriesBefore, entriesAfter);
    if (entriesChanged) {
      emit(`rejected: the revision ${entriesChanged} — the generated file stands`);
      continue;
    }
    // A condition entry stays a condition entry, and a clean one. The prompt
    // says so; this is what holds the reviewer to it. Rewritten into a `run`,
    // or into a condition that clicks, it would act on the page a decision is
    // asked about — and the set-of-entries check above cannot see it, because
    // the `source` did not move. Rejected the way every other violation here
    // is: the whole revision of this file, and the generated file stands.
    const brokenCondition = conditionEntryBroken(entriesBefore, entriesAfter);
    if (brokenCondition) {
      emit(`rejected: the revision ${brokenCondition} — the generated file stands`);
      continue;
    }
    const invalid = await validateCodeBehindSource(file, revised);
    if (invalid) {
      emit(`rejected: the revision does not compile (${invalid}) — the generated file stands`);
      continue;
    }
    await candidate.replaceFile(file, revised);
    emit(`revised ${basename(file)}`);
  }
}

/**
 * The first condition entry the revision CHANGED into something that is not a
 * clean condition — no longer defining `condition`, or failing
 * `conditionEntryComplaint` — described for the rejection line; null when
 * every one survived. Entries are paired by identity (section + source) and,
 * for identically-worded ones, by their order, the pairing
 * `describeEntryChange` has already confirmed is one-to-one.
 *
 * Only what the revision touched is judged: an entry whose code it left as it
 * was (whitespace aside) is the file's, not the reviewer's, and a hand-written
 * condition the static check happens to dislike must not block every review
 * of the file it sits in. An entry the revision turned INTO a condition is
 * judged like one it rewrote.
 */
function conditionEntryBroken(
  before: Array<{ source: string; section: string; code: string }>,
  after: Array<{ source: string; section: string; code: string }>,
): string | null {
  const sep = String.fromCharCode(0);
  const key = (e: { source: string; section: string }): string => `${e.section}${sep}${e.source}`;
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  const pending = new Map<string, Array<{ code: string }>>();
  for (const e of after) {
    const list = pending.get(key(e)) ?? [];
    list.push(e);
    pending.set(key(e), list);
  }
  for (const e of before) {
    const revised = pending.get(key(e))?.shift();
    if (!revised || same(e.code, revised.code)) continue;
    const was = entryDefinesCondition(e.code);
    const is = entryDefinesCondition(revised.code);
    if (!was && !is) continue;
    if (was && !is) {
      return `turns the condition entry for ${JSON.stringify(e.source)} into something that is not one`;
    }
    const complaint = conditionEntryComplaint(revised.code);
    if (complaint !== undefined) {
      return `breaks the condition entry for ${JSON.stringify(e.source)}: ${complaint}`;
    }
  }
  return null;
}

/**
 * How a revision changed the SET of entries, or null when it did not. Order
 * and code are the reviewer's to change; which steps have an entry is not.
 */
function describeEntryChange(
  before: Array<{ source: string; section: string }>,
  after: Array<{ source: string; section: string }>,
): string | null {
  const sep = String.fromCharCode(0);
  const key = (e: { source: string; section: string }): string => `${e.section}${sep}${e.source}`;
  const was = new Map<string, number>();
  for (const e of before) was.set(key(e), (was.get(key(e)) ?? 0) + 1);
  const now = new Map<string, number>();
  for (const e of after) now.set(key(e), (now.get(key(e)) ?? 0) + 1);
  const added = after.filter((e) => (now.get(key(e)) ?? 0) > (was.get(key(e)) ?? 0)).map((e) => e.source);
  const removed = before.filter((e) => (was.get(key(e)) ?? 0) > (now.get(key(e)) ?? 0)).map((e) => e.source);
  const quote = (sources: string[]): string => [...new Set(sources)].map((s) => JSON.stringify(s)).join(', ');
  if (added.length > 0 && removed.length > 0) {
    return `adds an entry for ${quote(added)} and removes ${quote(removed)}`;
  }
  if (added.length > 0) return `adds an entry for ${quote(added)}`;
  if (removed.length > 0) return `removes the entry for ${quote(removed)}`;
  return null;
}
