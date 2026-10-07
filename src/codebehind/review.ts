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
import { matchText } from '../parser/section-match.js';
import { logger } from '../utils/logger.js';
import type { Candidate } from './candidate.js';
import {
  conditionEntryComplaint,
  describeGuardedName,
  entryDefinesCondition,
  entryFaults,
  type EntryFault,
} from './generate.js';
import type { RecordedAction } from './recording.js';
import { scan } from './tokenizer.js';
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
  // `step.check` (docs/specs/SPEC-codebehind-robustness.md §6.5). Gated on the
  // file using it, as the condition rule is: a reviewer told about a call the
  // file does not make is invited to add one.
  const selfCheckNote = /\bstep\s*\.\s*check\s*\(/.test(input.file)
    ? ' A check an entry that only READS makes about its own read is `step.check(…)`: keep it\n' +
      '   `step.check`, and never put one in an entry that acts — there it must be `step.expect(…)`.\n' +
      '   An assertion the step itself states stays `step.expect(…)`.'
    : '';
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
   page — so "did not throw" means "the step worked". After an action that
   changes the page, the entry calls \`await step.settle()\` before it reads or
   asserts anything, then waits for the state the step names.${selfCheckNote}${flowControlException}${conditionException}
4. **Captures are written**: a step with \`[as: x]\` must call
   \`step.setVar('x', ...)\`.
5. **Stable selectors** (ids, \`data-testid\`, roles, labels) over positional
   or index-based ones — for a selector you write new. A selector an entry
   READS with (a read, a count, \`allTextContents\`, \`textContent\`, …) is part of
   what was read: the recorded run read the page with it, so keep it exactly as
   written, \`:first-child\` and \`:nth-of-type\` included. Swapping it for a
   "more stable" one changes what the step reads.
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
  "file": "// Generated by Steptix …\\nimport { defineSteps } …"
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
  /**
   * What each entry was generated from — the recorded actions and the values
   * of the pass that generated it — by file and entry identity
   * (docs/specs/SPEC-codebehind-robustness.md §6.2). A revised entry is held
   * to generation's static checks against it, and a revision that brings in a
   * fault the generated entry did not have — a read with a different selector
   * from the recording's above all — is rejected. For an entry used more than
   * once (a section called twice, a loop body), the FIRST pass to reach it:
   * the one whose transcript it was generated from. Absent, or answering
   * undefined for an entry, only the checks that need no recording run.
   */
  evidence?: ((file: string, entry: EntryIdentity) => EntryEvidence | undefined) | undefined;
  aiClient: AiClient;
  signal?: AbortSignal | undefined;
}

/** An entry as a file identifies it: its `source`, its `section` scope as
 *  `matchText` normalises it ('' for none), and its place among entries
 *  carrying the same two. */
export interface EntryIdentity {
  source: string;
  section: string;
  occurrence: number;
}

/** What one entry was generated from (§6.2). */
export interface EntryEvidence {
  /** 1-based expanded step of the pass it was generated from, for the
   *  rejection line. */
  step: number;
  actions: RecordedAction[];
  /** `stepSubstitution` for that pass. */
  substitute?: ((text: string) => string) | undefined;
  recordedCaptures?: Record<string, string> | undefined;
}

/** The key an {@link EntryEvidence} is stored and found under. */
export function evidenceKey(file: string, entry: EntryIdentity): string {
  const sep = String.fromCharCode(0);
  return [file, entry.section, entry.source, entry.occurrence].join(sep);
}

/** {@link evidenceKey} for a binding, whose section is the authored name. */
export function evidenceKeyOf(binding: {
  file: string;
  source: string;
  section?: string | undefined;
  occurrence: number;
}): string {
  return evidenceKey(binding.file, {
    source: binding.source.trim(),
    section: binding.section ? matchText(binding.section) : '',
    occurrence: binding.occurrence,
  });
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
    // Generation's static checks, on every entry the revision changed
    // (docs/specs/SPEC-codebehind-robustness.md §6.2). Review's own checklist
    // invites "stable selectors", and a read whose `:first-child` was dropped
    // that way reads six values where the run read three — and passes every
    // rejection above. Only a fault the generated entry did NOT have rejects:
    // the reviewer is held to the entry it was given, not to perfection.
    const changed = changedEntries(entriesBefore, entriesAfter);
    for (const pair of changed) logSelectorChanges(file, pair);
    const newFault = newlyFaulted(file, changed, input.evidence);
    if (newFault) {
      emit(`rejected: the revision ${newFault} — the generated file stands`);
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

/** One entry the revision changed, paired with its pre-revision self. */
interface ChangedEntry {
  identity: EntryIdentity;
  before: string;
  after: string;
}

/**
 * Every entry whose code the revision changed (whitespace aside), paired by
 * identity — section + source, and order among identically-identified ones,
 * the pairing `describeEntryChange` has already confirmed is one-to-one.
 */
function changedEntries(
  before: Array<{ source: string; section: string; code: string }>,
  after: Array<{ source: string; section: string; code: string }>,
): ChangedEntry[] {
  const sep = String.fromCharCode(0);
  const key = (e: { source: string; section: string }): string => `${e.section}${sep}${e.source}`;
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  const pending = new Map<string, Array<{ code: string }>>();
  for (const e of after) {
    const list = pending.get(key(e)) ?? [];
    list.push(e);
    pending.set(key(e), list);
  }
  const seen = new Map<string, number>();
  const out: ChangedEntry[] = [];
  for (const e of before) {
    const occurrence = seen.get(key(e)) ?? 0;
    seen.set(key(e), occurrence + 1);
    const revised = pending.get(key(e))?.shift();
    if (!revised || same(e.code, revised.code)) continue;
    out.push({ identity: { source: e.source, section: e.section, occurrence }, before: e.code, after: revised.code });
  }
  return out;
}

/**
 * The first changed entry that now fails a static check it passed before the
 * revision, described for the rejection line; null when none does.
 */
function newlyFaulted(
  file: string,
  changed: readonly ChangedEntry[],
  evidence: ReviewCandidateInput['evidence'],
): string | null {
  for (const pair of changed) {
    const known = evidence?.(file, pair.identity);
    const ctx = {
      source: pair.identity.source,
      ...(known && {
        actions: known.actions,
        ...(known.substitute && { substitute: known.substitute }),
        ...(known.recordedCaptures && { recordedCaptures: known.recordedCaptures }),
      }),
    };
    const had = new Set(entryFaults(pair.before, ctx).map((f) => f.check));
    const fresh = entryFaults(pair.after, ctx).find((f) => !had.has(f.check));
    if (fresh) return describeFault(fresh, pair, known);
  }
  return null;
}

function describeFault(fault: EntryFault, pair: ChangedEntry, known: EntryEvidence | undefined): string {
  if (fault.check === 'read') {
    const where = known ? `step ${known.step}` : JSON.stringify(pair.identity.source);
    return `changes the selector ${where} read with (${fault.selector ?? 'the recorded selector'})`;
  }
  return `brings a fault into the entry for ${JSON.stringify(pair.identity.source)}: ${fault.complaint}`;
}

/**
 * The calls whose first string argument is a selector, and the property an
 * entry hands one over in (`step.read({ selector })`).
 */
const SELECTOR_CALL = /(?:^|[^\w$])(?:locator|frameLocator|waitForSelector|\$\$?|\$\$?eval|querySelector(?:All)?|click|dblclick|fill|type|press|check|uncheck|hover|focus|tap|selectOption|setInputFiles|textContent|innerText|innerHTML|inputValue|getAttribute|isVisible|isHidden|isChecked|isEnabled|isDisabled|isEditable)\s*\(\s*$|(?:^|[^\w$])selector\s*[:=]\s*$/;

/** The selector strings an entry holds, in the positions {@link SELECTOR_CALL} names. */
function selectorLiterals(code: string): Set<string> {
  const scanned = scan(code);
  const out = new Set<string>();
  for (const token of scanned.strings) {
    const before = code.slice(Math.max(0, token.start - 40), token.start);
    if (SELECTOR_CALL.test(before)) out.add(token.value);
  }
  return out;
}

/**
 * Say in the log when the revision changed a selector an entry uses
 * (docs/specs/SPEC-codebehind-robustness.md §6.2, §6.8): failure B's
 * `:first-child` was lost to one of two rewrites, and the log could not say
 * which. A line per changed entry, whether or not the revision is kept.
 */
function logSelectorChanges(file: string, pair: ChangedEntry): void {
  const was = selectorLiterals(pair.before);
  const now = selectorLiterals(pair.after);
  const removed = [...was].filter((s) => !now.has(s));
  const added = [...now].filter((s) => !was.has(s));
  if (removed.length === 0 && added.length === 0) return;
  const list = (items: string[]): string => items.map((s) => JSON.stringify(s)).join(', ');
  logger.info(
    `Review of ${basename(file)} changed a selector in the entry for ${JSON.stringify(pair.identity.source)}` +
      (removed.length > 0 ? `: removed ${list(removed)}` : '') +
      (added.length > 0 ? `${removed.length > 0 ? ';' : ':'} added ${list(added)}` : ''),
  );
}
