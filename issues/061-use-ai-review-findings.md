# 061 — `[use ai]` review: twelve user-facing findings, not yet fixed

**Status:** open / known issues. Found by a review of PR #157 on 2026-09-24;
the user decided they are not a priority to fix now.
**Area:** the `[use ai]` step ([stories/use-ai-step.md](../stories/use-ai-step.md))
and the paths around it.
**Related:** [060](resolved/060-use-ai-step-stores-a-masked-secret-and-passes.md)
(a secret masked as `***` is stored).
**Opened:** 2026-09-24

## Summary

A review of PR #157 looked only for problems a test author or maintainer
would hit. It made twelve findings, and eleven are still open. Nine of those
were confirmed by a seam test, a probe of the built code, or a real-model
call. Two are plausible, and each says what would confirm it. The full
write-up, with raw evidence for each, is the triage page the review produced
(<https://claude.ai/artifact/MEzm8QWUhyEAX4yG3XRUUY>, private to the owner).
This file keeps the list in the repo.

Finding 1 was a step-cache bug: a short generated value rewrote later steps'
cached text. It was dropped when the step cache was removed. Code-behind, now
the only replay mechanism, only uses the names a step references
(`generate.ts:901`). The other findings keep their numbers so they still match
the triage page. Finding 13 is not on that page: a later review, of the fix
for issue 060, found it on 2026-09-29.

## The findings

Ranked by user impact. Line references are as of commit 197c50c.

1. *(Dropped with the step cache — see the summary.)*

2. **A misplaced or misspelled `[use ai]` passes green and stores nothing**
   (high). This happens when `… [use ai] [store as: text]` is run from
   TestBench (the squiggle doesn't block Run), from a hook or via the
   Sessions API. It also happens with `[use-ai]`, `[ai]` or `[useai]`, and
   with the new extension talking to an old server. The line reaches the page
   model, which makes up an `ai` action, and the executor's fallback counts
   an unknown action as success (`src/browser/actions.ts:566`). The fix is
   twofold: make an unknown action type fail the step, and call
   `useStepError` in the session, errand and hook loops.

   *Half fixed 2026-09-29:* the invented `ai` action is refused before it
   runs, and the retry offers the model an honest way out (an `assert` with
   `holds: false`) instead of inviting a substitute. Measured with the real
   model, the step went from passing on a name typed into an unrelated field 4
   times in 5 to failing with the page untouched 5 times in 5. That failure
   says the step cannot be done, not that `[use ai]` was misplaced; calling
   `useStepError` in the session, errand and hook loops, which would say so
   and make no model call, is still open.

3. **A secret-named generated value is sent in clear** (high). It appears in
   the step-pass `output`, which reaches TestBench's Output log and Test
   Results, MCP `steps[].output`, and the HTTP `reasoning`. The report and
   `captures` mask it. `Set` leaks the same way. Sources:
   `use-ai-step-runner.ts:286`, `session-manager.ts:7053` and `:7213`, and
   `errand-runner.ts:1114`. Mask those two fields with the run's secret set.

4. **The full server log traces the generated secret in clear** (medium).
   The AI client writes the reply to the log trace before the value is
   stored, so it is not yet known to be secret (`ai/client.ts:505`,
   `run-log.ts:65-77`). The runner should tell the client not to trace the
   reply's content.

5. **In a skill, `[Store as: x]`, `[store as : x]` and `[store as: x ]` are
   not renamed** (medium). The skill check accepts them, but the expander's
   `STORE_AS_RE` is case-sensitive and strict about spaces
   (`src/skills/expander.ts:35`). The value leaks into the caller's
   variables. The fix is to make that pattern accept the same spellings the
   `[use ai]` parser does.

6. **Long or decimal numbers lose digits if the model replies with a bare
   number** (low, plausible). `12345678901234567890` is stored as `…567000`,
   and `10.50` as `10.5` (`src/ai/action-parser.ts:979`). In real probes the
   model quoted its numbers.

7. **`…and store it in {{x}}` fails with a message that points the wrong
   way** (medium). The step says `{{x}}` "is not a parameter or captured
   variable", when the author meant to define it. The message should name the
   two spellings that work.

8. **The AI-off and no-key messages say to compile the step** (medium). A
   `[use ai]` step can't be compiled. The runner should replace both
   messages (`ai/client.ts:89`, `:161`) with one written for `[use ai]`.

9. **The CLI runs its page failure diagnosis for a failed `[use ai]` step**
   (low). That costs an extra model call about a page the step never used
   (`test-runner.ts:2772-2791`).

10. **A long answer cut off at the 4096-token output limit is reported as
    "not a JSON object"** (low, plausible). The retry then uses the same cap.

11. **TestBench completion and F12 miss `[output: x]` and `[store as : x]`
    names on a `[use ai]` line** (low). The Variables panel does list them
    (`env-data-completion-core.ts:258-263`).

12. **Three doc sentences don't match the code** (low):
    - `SPEC-SESSIONS-API.md:113` says the name check needs no AI call, but it
      runs after the reply and is retried.
    - The handbook's mistakes table (`test-writing-handbook.md:2172`) still
      says an unnamed step fails.
    - `test-writing-handbook.md:333` and `SPEC.md:163` say a skill's
      `[store as:]` is renamed per call, which holds only for the exact
      spelling.

13. **With no explicit name, a value can be stored under the wrong case**
    (medium). `[use ai] Write the single word OK and store it in ok`, answered
    `{"as": "ok", "value": "OK"}`, stored the value as `{{OK}}`, not `{{ok}}`.
    `nameTheStepGives` returns the spelling of the FIRST case-insensitive
    whole-word match in the step (`use-ai-step-runner.ts:114-118` as of
    b700473), and here that is the word the step quotes, "OK", which comes
    before the name. Variable names are case-sensitive, so a later `{{ok}}` is
    left literal with only a warning and fails somewhere else. Found by the
    review of the issue-060 fix on 2026-09-29. The fix is to prefer a
    whole-word match in the model's exact spelling, and to fall back to the
    case-insensitive match only when there is none.

## Revisit when

- Someone picks up finding 2. Re-check its old-server case first against the
  server as it stands after the step-cache removal.
- Anyone reports a green step that stored nothing, or a secret in a TestBench
  log. Findings 2 and 3 are the likely cause.
