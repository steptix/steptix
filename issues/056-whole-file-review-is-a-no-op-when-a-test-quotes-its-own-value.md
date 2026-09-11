# 056 — the whole-file review pass is a no-op on a test that quotes one of its own values

**Status:** open / known limitation — found by review while building
[stories/step-failure-outcomes.md](../stories/step-failure-outcomes.md), not
introduced by it.
**Area:** [src/codebehind/compile.ts](../src/codebehind/compile.ts) (~line 769,
the `guarded:` argument to `reviewCandidate`) and
[src/codebehind/live-compile.ts](../src/codebehind/live-compile.ts) (~line 1284,
the same argument built by `guardedValues()`).
**Related:** [src/codebehind/generate.ts](../src/codebehind/generate.ts) —
`guardedValues` / `authorQuotedLiterals`, the per-step exemption this pass does
not have.
**Opened:** 2026-09-11

## Summary

The review pass is asked to guard EVERY parameter value in play, because a
whole-file rewrite can move a literal into any entry:

```ts
guarded: [...allParameters(parameters), ...allEnvRefs(test)],
```

The per-step generation and both repair sites pass the step's own authored line
beside that list, so a value the AUTHOR quoted in the step is exempt — an entry
echoing it is repeating the step, not inlining a resolved value. The review pass
has no single authored line to read, so it passes none, and nothing is exempt.

That is fine until a test writes one of its own values down. The live fixture
does:

```markdown
8. Set {{a}} to "peanuts"
9. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
```

Step 8 puts `a=peanuts` in the run's parameters, so `peanuts` is guarded for the
whole file. Step 9's entry cannot avoid it — the correct code is
`if (step.getVar('a') === 'peanuts') step.fail('…')` — so `peanuts` is in the
file before the reviewer sees it, and every revision it hands back trips the
leak check:

```
rejected: the revision inlines a — the generated file stands
```

Once per reviewed file, on every compile of that test. The review pass is a
no-op there, silently.

## Why it is a limitation and not a bug

The rejection is safe in the direction that matters: the PRE-review file stands,
and that file was generated and replayed under the per-step guard, which does
have the exemption. So nothing false passes and no secret leaks. What is lost is
the review's own product — the whole-file tidy-up (shared helpers, consistent
naming) — on exactly the tests that use the `Set` + `If {{x}} is "<literal>"`
shape the failure-outcomes story added.

It is also invisible unless someone reads the compile's review lines, which is
how it survived: the message says "the generated file stands", which reads like
a considered outcome rather than a guard that can never pass.

## What a fix looks like

1. Export `authorQuotedLiterals` from `generate.ts` (it is module-private today).
2. At both review sites, exempt the UNION of `authorQuotedLiterals` over every
   bound step's source — the file-wide analogue of the per-step exemption. The
   boxed site has `test.expansion?.rawSteps ?? test.steps` to hand (it already
   passes it as `steps:`); the live site has `this.plan.map((p) => p.text)`.
   Both are the same list the reviewer is shown, so the guard would exempt
   exactly what the reviewer was told the author wrote.
3. Either thread the union through as a second argument to `guardedValues`, or
   filter the list at the call site. The first keeps one rule in one place.
4. A test in `tests/codebehind-failure-outcomes.test.ts` that compiles the
   `Set` + `If {{a}} is "peanuts"` pair with a review response that changes the
   file, and asserts the revision is APPLIED rather than rejected.

## Revisit when

- Someone reports the review pass never revising a particular test, or
- `guardedValues` / the review's `guarded` argument is touched for any other
  reason.
