# 016 — Server step-cache keys collide across skill/test files; skill-body edits don't invalidate

> **RESOLVED 2026-05-26.** Both bugs fixed. **Bug 1** (per-step key collision):
> frame-scoped cache keys (`f<n>-<line>`) so skill-body steps and repeated
> invocations no longer share a `step-<line>.json` — design
> [skill-cache-key-collision.md](../testbench-native/stories/specs/skill-cache-key-collision.md).
> **Bug 2** (skill-body edits didn't invalidate): the bundle hash is now over
> the **expanded** document, so editing a skill body changes the hash and clears
> the bundle, while a subset/resume batch re-expands the full document to stay
> hash-stable — design
> [skill-cache-invalidation.md](../testbench-native/stories/specs/skill-cache-invalidation.md).
> Original analysis kept below.

**Status:** resolved 2026-05-26 (Bug 1 + Bug 2 fixed; was: open / high priority)
**Area:** [src/server/session-manager.ts](../src/server/session-manager.ts) — per-step cache id (`stepCacheId`), cache-hash source; [src/cache/step-cache.ts](../src/cache/step-cache.ts) — `step-<id>.json` naming
**Related:** [012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md) (sibling cache-key issue), [step-cache-server.md](../testbench-native/stories/specs/step-cache-server.md) §2/§8 (the spec claims this violates), fix spec [skill-cache-key-collision.md](../testbench-native/stories/specs/skill-cache-key-collision.md)
**Opened:** 2026-05-26

## Summary

The server path keys each step's cache file by its **source line within its
own file** ([session-manager.ts:1544](../src/server/session-manager.ts#L1544),
`stepCacheId = effectiveSourceLines?.[i] ?? i + 1`). After skill expansion,
the flat per-test cache directory mixes line numbers from *different files*:
inline test steps use test-file lines, skill-body steps use skill-file lines
([session-manager.ts:1019-1022](../src/server/session-manager.ts#L1019-L1022)).
Line numbers are unique within a file but **not across files**, so two distinct
logical steps that happen to share a line number write to the same
`step-<n>.json` ([step-cache.ts:191-197](../src/cache/step-cache.ts#L191-L197))
and poison each other.

The spec ([step-cache-server.md](../testbench-native/stories/specs/step-cache-server.md)
§2) defined the per-step ID as "the 1-based line number **in the test file**"
— it never anticipated skill-body steps carrying their own skill-file line
numbers into the same namespace. This is a spec/impl gap exposed by skills.

## Bug 1 — cross-file / repeated-invocation cache-key collision

Two distinct steps collide whenever their (file-local) line numbers coincide:

1. **Same skill invoked on more than one step — guaranteed.** `skill.stepLines`
   is fixed per skill file, so every invocation emits identical `skillLine`
   values. Both invocations key to the same `step-<line>.json`. With different
   args the collision produces a *wrong result on the first run*: the skill's
   `query` (etc.) is interpolated into the step text at expansion
   ([expander.ts:458](../src/skills/expander.ts#L458)), **not** into runtime
   `resolvedParameters`, so reverse-interpolation on write doesn't templatize
   it. Invocation #2 cache-hits invocation #1's freshly-written file and
   replays #1's actions.

   ```
   ## Steps
   1. [skill: duckduckgo_search query="cats" out.first_result_url="a"]
   2. [skill: duckduckgo_search query="dogs" out.first_result_url="b"]
   ```
   Both expand to skill lines 17/18/19 → both key to `step-17/18/19.json`.
   Step 2 replays `type "cats"`.

2. **A test step and a skill-body step on the same line number** → one poisons
   the other.
3. **Two different skills with body steps on the same line number** → collide.

The assertion-code cache rides the same id (`step-<line>-asserts.json`,
[step-cache.ts:195](../src/cache/step-cache.ts#L195)), so it has the same
exposure.

[skill-demo.md](../testbench-native/tests/integration/fixtures) and the user's
real `skill-demo.md` happen *not* to collide (test lines 12/14, skill lines
17/18/19 are all distinct) — but that is luck, not safety: move the skill's
`## Steps` up a few lines and its body lands on 12/14.

## Bug 2 — editing a skill body doesn't invalidate dependent caches

Whole-cache staleness is a SHA over `request.fullSteps ?? effectiveSteps`
([session-manager.ts:1069](../src/server/session-manager.ts#L1069),
[step-cache.ts:228](../src/cache/step-cache.ts#L228)). The client builds
`fullSteps` from the **test document only** —
`extractSteps(this.document.getText())`
([run-controller.ts:969](../testbench-native/src/extension/run-controller.ts#L969))
— so it contains the literal `[skill: …]` line, never the expanded skill body.
Edit what a skill *does* and the test's hash is unchanged → the skill's
per-step entries replay stale actions. This directly contradicts
[step-cache-server.md](../testbench-native/stories/specs/step-cache-server.md)
§2 ("editing any skill body invalidates the whole bundle") and §8 ("cache
invalidates on skill edits via the bundle hash"). The `clearSkillCache` fix
referenced in §8 only refreshes the in-memory *parse* of the skill; it does
not feed the new body into the cache hash, so it does not help.

These are orthogonal: Bug 1 is key *uniqueness*, Bug 2 is the invalidation
*trigger*. Frame-scoped keys (Bug 1) make the within-run case correct by
construction; the only residual cross-run contamination for repeated
invocations requires Bug 2's staleness to also be present, and fixing Bug 2
closes it.

## Fix

**Bug 1 (this pass):** key each step by **frame + source line**, not source
line alone. The expander already mints a distinct frame per `[skill: …]`
invocation (`f${++ctx.seq}`,
[expander.ts:249](../src/skills/expander.ts#L249)/[:256](../src/skills/expander.ts#L256)),
exposed as `origins[i].frameId`. Top-level inline steps (frame `''`) keep the
bare line (`step-12.json`); skill-body steps become `step-f1-17.json`. Keys are
unique per run by construction and stable across runs for an unchanged
test+skills set, so cache hits still work. The cache *line/display* identity
(`StepResult.index`, status events, log lines) stays the source line — only the
on-disk filename gains the frame prefix. Schema version bumps to discard
pre-fix line-keyed caches. CLI path is unaffected (it keys by post-expansion
ordinal, which never collides). Design: [skill-cache-key-collision.md](../testbench-native/stories/specs/skill-cache-key-collision.md).

**Bug 2 (fixed):** hash the **expanded** document instead of the client's
pre-expansion `fullSteps`, so a skill-body edit changes the expanded text and
the bundle hash. A subset (paused/resumed or `[input:]`-split) batch re-expands
the full document for the hash so it stays identical to a full run's — the
batched-resume hash-stability contract (§4 of step-cache-server.md) is preserved.
Whole-bundle invalidation (matching prior behaviour). Design + edge cases:
[skill-cache-invalidation.md](../testbench-native/stories/specs/skill-cache-invalidation.md).

## Tests this needs

- Same skill on two steps with **different args** → second invocation does not
  replay the first's actions (distinct frame-scoped keys; no AI call avoided
  incorrectly).
- A test step and a skill-body step on the same line number → independent cache
  entries.
- Re-run of an unchanged test with a skill invocation → all skill-body steps
  cache-hit (keys stable across runs).
- No-skills test → keys unchanged (bare line), CLI path unchanged (ordinal).

## Discovered while

Reviewing "caching issues with step numbers, particularly when skills are
involved" — a follow-on to the cache-opt-in work and issue 010.
