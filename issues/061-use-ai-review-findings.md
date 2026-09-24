# 061 — `[use ai]` review: twelve user-facing findings, not yet fixed

**Status:** open / known issues. Found by a review of PR #157 on 2026-09-24;
the user decided they are not a priority to fix now.
**Area:** the `[use ai]` step ([stories/use-ai-step.md](../stories/use-ai-step.md))
and the paths around it.
**Related:** [060](060-use-ai-step-stores-a-masked-secret-and-passes.md)
(a secret masked as `***` is stored), [023](023-cache-reverse-interpolation-substring-collision.md)
(cache reverse-interpolation).
**Opened:** 2026-09-24

## Summary

A review of PR #157 looked only for problems a test author or maintainer
would hit. Ten findings were confirmed by a seam test, a probe of
the built code, or a real-model call. Two are plausible, and each says what
would confirm it. The full write-up, with raw evidence for each, is the
triage page the review produced
(<https://claude.ai/artifact/MEzm8QWUhyEAX4yG3XRUUY>, private to the owner).
This file keeps the list in the repo.

**Direction that changes the ranking:** step caching for selectors is going
to be removed, and only code-behind will replay in future. Finding 1 is a
step-cache bug, so it goes away with the cache. It is kept below for the
record, not for fixing.

## The findings

Ranked by user impact. Line references are as of commit 197c50c.

1. **The step cache rewrites later steps' text when a generated value is
   short** (high; moot once the step cache is removed). With the cache on,
   `[use ai] … [store as: qty]` answering `5` makes a later
   `Type "15.50"` cache as `1{{qty}}.{{qty}}0`, and the next run types
   `13.30`, green. This is issue 023, made routine by values that change on
   every run. `src/cache/step-cache.ts:114-123`. Code-behind is not affected:
   it only uses the names a step references (`generate.ts:901`).

2. **A misplaced or misspelled `[use ai]` passes green and stores nothing**
   (high). This happens when `… [use ai] [store as: text]` is run from
   TestBench (the squiggle doesn't block Run), from a hook or via the
   Sessions API. It also happens with `[use-ai]`, `[ai]` or `[useai]`, and
   with the new extension talking to an old server. The line reaches the page
   model, which makes up an `ai` action, and the executor's fallback counts
   an unknown action as success (`src/browser/actions.ts:566`). The fix is
   twofold: make an unknown action type fail the step, and call
   `useStepError` in the session, errand and hook loops.

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

## Revisit when

- The step cache is removed. At that point, close finding 1 and re-check
  finding 2's old-server case against whatever replaces it.
- Anyone reports a green step that stored nothing, or a secret in a TestBench
  log. Findings 2 and 3 are the likely cause.
