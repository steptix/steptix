# 037 — A resumed batch can read a cache entry written for a different step

**Status:** partially closed — the wrong-entry READ is prevented as of the
inline-sections server work; the lost cache HITS remain.
**Area:**
[src/cache/step-cache.ts](../src/cache/step-cache.ts) (`frameScopedStepKey`);
[src/server/session-manager.ts](../src/server/session-manager.ts) (mints frame
ids by walking the batch, then builds the per-step key from them).
**Related:** [016](016-testbench-config-baseurl-no-datasource-interpolation.md)
Bug 2 (the bundle-hash half of the same problem, fixed);
[src/server/cache-hash-source.ts](../src/server/cache-hash-source.ts).
**Opened:** 2026-07-23

## Summary

A per-step cache key is `` `${frameId}-${sourceLine}` `` — for example
`f1-7`. The frame id is minted by walking **the batch**, not the document, so
the same step gets a different id depending on how much of the document was
sent.

Run a document in one batch and the second skill body gets `f2`. Resume the
same document from a breakpoint, sending only the tail, and that same body is
now the first frame in the batch and gets `f1`. Its key changes from `f2-7` to
`f1-7`.

Two consequences, in increasing order of seriousness:

1. **The entry is missed.** The resumed batch looks up a key the full run
   never wrote. Wasted work, no wrong answer.
2. **A *different* entry is hit.** If some other frame in the full run held
   ordinal 1 and had a body step on line 7, `f1-7` exists — written for a
   different instruction, in a different file. The resumed batch replays that
   frozen action plan.

Case 2 is silent and the run passes.

## Reproduction

Document mixing a skill and a section whose body steps both sit on line 7 of
their respective files, cache enabled, captured at the `executeStep` seam:

```
full run : f1-7  <- "Enter the credit card number"   (skill body)
           4     <- "Middle"                          (main flow)
           f2-7  <- "Click the confirm button"        (section body)

resumed  : f1-7  <- "Click the confirm button"        (section body)
```

The resumed batch reads `step-f1-7.json`, which the full run wrote for the
skill step. The bundle hash is identical across both runs, so
`StepCache.initialize` does not wipe the entry — it is a live read.

## Why it is filed now

The frame-ordinal shift is **pre-existing** and reproduces with two skills and
no sections at all. Inline sections did not introduce it.

What sections change is the collision surface. A section body lives in the
**test file**, so its line numbers now share a key space with skill-file line
numbers. Two skill files colliding on the same small line number is possible;
a test file and a skill file both having a step on line 7 is ordinary.

The `sections` field is not sent by any shipped client yet, so nothing is
reaching this today. It will be once the native-runtime work lands, which is
why this is filed rather than left to be rediscovered.

## Update — the dangerous half is closed

The server now skips per-step cache reads and writes for steps in a non-root
frame on a subset batch (runtime spec §4.3). Case 2 above — reading an entry
written for a *different* step — can no longer happen, because the unstable
keys are no longer consulted at all.

Case 1 (a missed entry) remains, and is now the deliberate behaviour rather
than an accident: a subset batch gets guaranteed-correct misses for skill and
section body steps instead of occasionally-wrong hits. Root-frame steps keep
their stable empty-frame-id keys and still hit.

What is left is a performance issue, not a correctness one. Option 2 below is
still the real fix.

## Options

1. **Put the origin URI in the key.** Turns case 2 (wrong hit) into case 1
   (miss), which is the safety-critical half, and is a small change. Costs
   every user their existing cache once, since the key format changes.
2. **Make frame ids document-stable.** Derive the ordinal from the full
   document rather than the batch — the server already receives `fullSteps`.
   Fixes both cases and needs no key-format change, but means minting ids
   from an expansion the batch does not otherwise need.
3. **Include the instruction text in the key.** Correct by construction, but
   defeats the point of a stable key across an edit-free re-run.

Option 2 is the real fix; option 1 is the cheap one that removes the silent
failure. They are not mutually exclusive.

## Revisit when

- The native runtime starts sending `sections` (the collision surface widens
  materially at that point), or
- anyone reports a cached step replaying the wrong action after resuming from
  a breakpoint.
