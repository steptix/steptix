/**
 * What a finished compile SAYS — the run log's one line and the
 * partial-compile notification's tail.
 *
 * Pure string logic, no VS Code dependency, so the fast `node --test` suite can pin
 * the wording — the split `failure-outcome-core.ts` and `step-skip-core.ts` are on,
 * because an output-channel line and a notification cannot be read back out of the
 * extension host once rendered. The two lived in `run-controller.ts` and
 * `commands/index.ts`, either side of a `vscode` import, which is why the sentence
 * that sent an author to fix a working step went unpinned in both.
 *
 * The vocabulary they share is the point (stories/step-failure-outcomes.md, §"What
 * the compile showed"): a summary can say where the run STOPPED or where it ENDED
 * as its own text says, never both, and every word of the second differs — nothing
 * failed under AI, and there is nothing to fix.
 */

import path from 'node:path';
import type { CompileResultEvent } from 'steptix-runner-core';

/** "Steps 6–9", "Step 4", "Steps 2, 5". */
export function listSteps(numbers: number[]): string {
  if (numbers.length === 1) return `Step ${numbers[0]}`;
  const sorted = [...numbers].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return contiguous
    ? `Steps ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `Steps ${sorted.join(', ')}`;
}

/**
 * The sentence a partial compile adds to its notification: where the run
 * stopped or ended, what was written off, what is unproven. Each part only
 * when it applies, so a plain prefix compile reads as one short instruction.
 */
export function partialNotes(summary: {
  stoppedAt?: { step: number; error: string };
  endedAsWritten?: { step: number; error: string; line: string };
  notAttempted: number[];
  writtenOffAi: number[];
  unproven: number[];
  unprovenReads?: Array<{ step: number; reason: string; keptEntry?: boolean }>;
}): string {
  const parts: string[] = [];
  // The steps a stop or an end kept from running. A step that ran on a list
  // read proving nothing is said apart, below: fixing the stop, or a run that
  // goes past the end, does nothing for it.
  const notReached = notReachedOf(summary);
  if (summary.stoppedAt) {
    parts.push(
      ` Step ${summary.stoppedAt.step} failed under AI — ${summary.stoppedAt.error}.` +
        (notReached.length > 0 ? ` ${listSteps(notReached)} not attempted.` : '') +
        ' Fix it, run, and compile again for the rest.',
    );
  }
  // The run ended where the test says it ends — the `fail` verb (decisions 1–3).
  // Mutually exclusive with the branch above, and every word different on purpose:
  // nothing failed under AI, and what is owed is a run that does not end there.
  // `notAttempted` is named here as well as above, because the branch above is
  // where it used to be named ONLY — so dropping `stoppedAt` for an ended run
  // silently took the list away too.
  if (summary.endedAsWritten) {
    parts.push(
      ` Ended at step ${summary.endedAsWritten.step} as its text says — ` +
        `${summary.endedAsWritten.error}.` +
        (notReached.length > 0
          ? ` ${listSteps(notReached)} not attempted — a run that does not end there ` +
            'compiles the rest.'
          : ''),
    );
  }
  if (summary.writtenOffAi.length > 0) {
    parts.push(
      ` ${listSteps(summary.writtenOffAi)} kept AI after replay failures — fix the cause, then Compile This Step.`,
    );
  }
  if (summary.unproven.length > 0) {
    parts.push(` ${listSteps(summary.unproven)} unproven — the next run proves or flags them.`);
  }
  const notCompiled = notCompiledNote(summary.unprovenReads ?? []);
  if (notCompiled !== '') parts.push(` ${notCompiled}`);
  return parts.join('');
}

/** `notAttempted` without the steps {@link notCompiledNote} says. */
function notReachedOf(summary: {
  notAttempted: number[];
  unprovenReads?: Array<{ step: number }>;
}): number[] {
  const unprovenSteps = new Set((summary.unprovenReads ?? []).map((u) => u.step));
  return summary.notAttempted.filter((n) => !unprovenSteps.has(n));
}

/**
 * The steps that ran, and passed, on a list read that proves nothing about its
 * selector (issue #48), in their own words: one step with the compile's
 * reason, several with what they share. Empty when there are none.
 */
export function notCompiledNote(reads: Array<{ step: number; reason: string; keptEntry?: boolean }>): string {
  if (reads.length === 0) return '';
  const kept = reads.every((r) => r.keptEntry === true)
    ? ` ${reads.length === 1 ? 'Its' : 'Their'} entry is left as it was.`
    : '';
  if (reads.length === 1) return `Step ${reads[0]!.step} not compiled — ${asSentence(reads[0]!.reason)}${kept}`;
  return (
    `${listSteps(reads.map((r) => r.step))} not compiled — each ended on a list read that proves nothing ` +
    `about its selector.${kept}`
  );
}

/**
 * The one line a compile-mode run leaves in the log when its result arrives
 * (stories/compile-as-you-go.md). It stands in for the `compile:done`
 * narrative the boxed pipeline sends, which this path has no phase to hang
 * off — and it says "unproven" out loud, because that is the trade this
 * feature makes: no Replay rounds, and the author's next ordinary run is the
 * proof.
 */
export function compileResultLine(event: CompileResultEvent): string {
  const summary = event.summary;
  const name = path.basename(summary.test);
  // A step that ran on a list read proving nothing is not one the run failed
  // to reach: it is said in its own words, and left out of every count of
  // steps not attempted.
  const notReached = notReachedOf(summary);
  const notCompiled = notCompiledNote(summary.unprovenReads ?? []);
  const notCompiledTail = notCompiled === '' ? '' : ` ${notCompiled}`;
  // A run that ENDED as written is not a run that stopped (decisions 1–3): the step
  // did what its line says, so the sentence has to be the boxed compiler's — "ended
  // at step N as its text says" — and none of the stopped vocabulary, which sends
  // the author to repair working work.
  const ended = summary.endedAsWritten;
  /** Nothing reached the proposal: no entry written, no `ai: true` write-off. */
  const wroteNothing = summary.compiled === 0 && summary.keptAi === 0;
  // "Compiled nothing" is a complaint and `green` is the compile saying nothing was
  // owed, so it is never the sentence for a green result: a green compile that
  // wrote nothing attempted nothing either, which is the ✓ line below. Guarded here
  // as well as narrowed at the source, because the renderer is handed a summary it
  // did not build — before both, the live compiler's "the ending step was the LAST
  // one" case came through `green` carrying `endedAsWritten` and printed
  // "◐ Compiled nothing…" over it.
  if (event.status === 'green' && wroteNothing) {
    return (
      `✓ Nothing to compile in ${name} — ` +
      (notReached.length > 0
        ? `no step needed an entry (${notReached.length} step(s) not attempted).`
        : 'every step already has code-behind.') +
      (ended ? ` The run ended at step ${ended.step} as its text says — ${ended.error}.` : '') +
      notCompiledTail
    );
  }
  const nothingHappened = wroteNothing && !summary.stoppedAt && !ended;
  // Why a FAILED compile failed, which every failed line below carries. `error` is
  // read only for `failed`: on a `partial` result it restates what the line already
  // says (the ending, or the "could not be generated" count), and on `green` there
  // is none. Blank counts as absent, so an empty field cannot print a bare dash.
  const failedWhy = event.status === 'failed' ? summary.error?.trim() || undefined : undefined;
  // A compile the server REFUSED — before any step ran, or at a step it will not
  // compile — comes back `failed` with nothing written, nothing stopped, nothing
  // named as not attempted, and the refusal in `summary.error`
  // (`emitCompileRefusal`, session-manager.ts). Every count is zero for it, so the
  // zero counts alone read as a clean result: this line used to print "✓ Nothing
  // to compile — every step already has code-behind" over a compile that did
  // nothing because it was told no. `failed` never earns a ✓. The refusal leads,
  // because it is the only sentence here that says what to do next.
  if (event.status === 'failed' && nothingHappened && summary.notAttempted.length === 0) {
    return (
      `✗ Did not compile ${name}: ` +
      (failedWhy ? asSentence(failedWhy) : 'the compile failed before any step produced an entry.')
    );
  }
  // "Every step already has code-behind" is only true when the run reached every
  // step. Stopped with nothing generated, it says the opposite of what happened.
  if (nothingHappened && summary.notAttempted.length === 0) {
    return `✓ Nothing to compile in ${name} — every step already has code-behind.${notCompiledTail}`;
  }
  // After the stopped / ended wording, never instead of it, and never when it
  // would only repeat the step error that wording already quotes.
  const failedTail =
    failedWhy !== undefined && failedWhy !== summary.stoppedAt?.error?.trim()
      ? ` ${asSentence(failedWhy)}`
      : '';
  // Nothing compiled, and only because every step left had a list read that
  // proved nothing: the run did not stop, and nothing failed.
  if (nothingHappened && notReached.length === 0) {
    return `◐ Compiled nothing in ${name}: ${notCompiled}${failedTail}`;
  }
  if (nothingHappened) {
    return (
      `✗ Compiled nothing in ${name}: the run stopped before any step produced an entry ` +
      `(${notReached.length} step(s) not attempted).` +
      notCompiledTail +
      failedTail
    );
  }
  // The same "nothing came of it" line for a run that ended as written, in that
  // run's own words and with no ✗: an author who wrote the ending step is owed a
  // run that goes past it, not a report of a failure. Not for a `failed` result,
  // whose ✗ and reason the general line below keeps.
  if (wroteNothing && ended && event.status !== 'failed') {
    return (
      `◐ Compiled nothing in ${name}: ended at step ${ended.step} as its text says — ` +
      `${ended.error}` +
      (notReached.length > 0
        ? ` (${notReached.length} step(s) not attempted).`
        : '.') +
      notCompiledTail
    );
  }
  const parts = [`${summary.compiled} step(s) as code (unproven — the next run proves them)`];
  if (summary.keptAi > 0) parts.push(`${summary.keptAi} kept AI`);
  if (summary.stoppedAt) {
    parts.push(`stopped at step ${summary.stoppedAt.step} — ${summary.stoppedAt.error}`);
  }
  if (ended) {
    parts.push(`ended at step ${ended.step} as its text says — ${ended.error}`);
  }
  if (notReached.length > 0) {
    parts.push(`${notReached.length} step(s) not attempted`);
  }
  const glyph = event.status === 'green' ? '✓' : event.status === 'partial' ? '◐' : '✗';
  return `${glyph} Compiled ${name}: ${parts.join('; ')}.${notCompiledTail}${failedTail}`;
}

/** `text` ending in terminal punctuation — the server's refusals mostly do, and
 *  a few (`Tool catalogue load failed: …`) end on whatever the cause said. A
 *  closing quote or bracket after the stop still counts as ended. */
function asSentence(text: string): string {
  return /[.!?…]["'”’)]*$/.test(text) ? text : `${text}.`;
}
