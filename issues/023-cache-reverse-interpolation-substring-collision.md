# 023 — Step cache: parameter reverse-interpolation corrupts cached actions on substring collisions

**Status:** open / medium-high priority (silent data corruption, not a loud failure)
**Area:** [src/cache/step-cache.ts:274-294](../src/cache/step-cache.ts#L274) (`reverseInterpolate` — action `value` fields), [src/cache/step-cache.ts:300-315](../src/cache/step-cache.ts#L300) (`reverseInterpolateString` — raw response), [src/cache/step-cache.ts:321-333](../src/cache/step-cache.ts#L321) (`forwardInterpolate` — read side), [src/parser/parameters.ts:92-100](../src/parser/parameters.ts#L92) (`interpolate`)
**Related:** [issues/012-step-cache-not-env-aware.md](012-step-cache-not-env-aware.md), [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) — same subsystem (the param read/write interpolation that 018 deliberately preserves); this issue is a correctness bug *inside* that mechanism.
**Opened:** 2026-06-03

## Summary

The step cache stores an AI action plan with parameter **values** replaced by
`{{placeholder}}` tokens so one cached plan can serve many parameter values
("params ride the cache"). The replacement is a blind, literal
`String.prototype.replaceAll(paramValue, '{{key}}')`
([step-cache.ts:289](../src/cache/step-cache.ts#L289)) run over **every**
`action.value` in the plan — not just the fields the parameter actually fed.

When a parameter's resolved value happens to be a **substring of unrelated text**
in another action (or appears more than once inside one value), reverse
interpolation rewrites those incidental occurrences too. On the next run,
`forwardInterpolate` pours the *new* value into those wrong spots, silently
corrupting actions that had nothing to do with the parameter.

## Mechanism

On cache **write** ([step-cache.ts:107-126](../src/cache/step-cache.ts#L107)):

```ts
// reverseInterpolate, sorted longest-value-first, values with length > 0
value = value.replaceAll(paramValue, `{{${key}}}`);
```

There is no notion of "which action this parameter was interpolated into" — the
write pass walks the *entire* action list and replaces any literal occurrence of
the value string. On **read** ([step-cache.ts:95-100](../src/cache/step-cache.ts#L95)),
`forwardInterpolate` → `interpolate` substitutes every `{{key}}` back to the
current value. The two passes are only inverses when the value appears **exactly
and only** where the parameter was meant to go.

The longest-first sort ([step-cache.ts:280](../src/cache/step-cache.ts#L280))
guards *param-vs-param* nesting (so `{{name}}="Sam"` doesn't pre-empt
`{{fullName}}="Samuel"`). It does **nothing** for a value colliding with
incidental, non-parameter text.

The same flaw applies to `reverseInterpolateString` over the stored
`rawResponse`, but that only feeds the report display; the load-bearing
corruption is in `action.value`, which is what the executor replays.

## Worked example (concrete)

A test has `## Parameters` `env` whose resolved value is `dev`. The cached plan
for a step contains a navigate action the AI emitted:

```jsonc
// AI plan as produced this run (env = "dev")
{ "action": "navigate", "value": "https://dev.example.com/devices" }
```

Reverse interpolation replaces **every** `"dev"` substring with `{{env}}`:

```jsonc
// what gets written to step-<key>.json
{ "action": "navigate", "value": "https://{{env}}.example.com/{{env}}ices" }
//                                          ^^^^^^^             ^^^^^^^  ← collateral hit inside "devices"
```

Next run with `env = "qa"` (cache HIT — params ride, hash unchanged), forward
interpolation yields:

```jsonc
{ "action": "navigate", "value": "https://qa.example.com/qaices" }
//                                                        ^^^^^^ corrupted: "/devices" → "/qaices"
```

The test now navigates to a broken URL. A shorter/common value makes this worse:
`{{code}}="1"` rewrites every `1` in every action value (indices, IDs, prices)
to `{{code}}`.

## Impact

- **Silent corruption**, not a clean miss. The cache "hits" and replays a
  mangled action. Failures look like application/selector bugs, not cache bugs —
  expensive to diagnose.
- Triggered by ordinary inputs: short values (`"1"`, `"a"`, `"US"`,
  `"on"`), or values that legitimately recur (an env name, a product code that's
  also a URL segment).
- Worsens as more parameters/captures are in play, since every value is a
  candidate substring.

## Fix sketches

**Option A — scope reverse-interpolation to the fields a parameter actually
touched (most correct, but harder than it looks).** The instruction *is*
interpolated before the AI call ([test-runner.ts:457](../src/runner/test-runner.ts#L457)),
but the AI then **composes each `action.value` freely** from that instruction —
it can synthesize `https://dev.example.com/devices` from a `dev` parameter. So
there is **no recorded mapping** from a `{{key}}` to the substring it produced in
a given action field; reconstructing one means string-searching the value, which
reintroduces the same collision. Making Option A real therefore requires either
*constraining how the AI emits parameter-derived values* (e.g. echo the
placeholder token in the value so the cache can substitute it back unambiguously)
or accepting the ambiguity it's meant to fix. This is a design change, not just
plumbing.

**Option B — word-boundary / delimiter-aware replacement (cheap mitigation).**
Only replace occurrences bounded by non-alphanumeric delimiters (or the
string ends), so `dev` inside `devices` is left alone. Reduces collisions
dramatically but is heuristic — fails for values that legitimately abut other
text, and for non-word values.

**Option C — guard against ambiguous values; fall back to value-in-hash.** When
a parameter value is "risky" (short, or appears more than once, or as a
substring of another action's value), **don't** reverse-interpolate it — store
the concrete value and instead fold that parameter into the bundle hash so a
value change busts the cache (correctness over token-saving for that case only).
This trades some cache hits for safety, and is local to the cache layer.

**Recommended:** B as an immediate mitigation (small, local, kills the common
case), with A tracked as the principled fix if collisions persist. C is a good
backstop for pathologically short values regardless.

## Open questions

1. Do we have the placeholder→action-field provenance available at cache-write
   time, or is it discarded once the instruction is interpolated and sent to the
   AI? (Determines whether Option A is cheap or a refactor.)
2. Is word-boundary matching (Option B) safe for the value classes we actually
   see — codes, URLs, names — or do real values abut other text often enough to
   make it unreliable?
3. Should captured values (`read … [store as: x]`) be treated differently from
   declared `## Parameters`? Captures are page-derived and arguably *more* likely
   to be short/ambiguous.
4. What's the right severity bar to disable reverse-interpolation for a value
   (Option C): length threshold, occurrence count, or "appears in >1 action"?

## Tests this would need

- A param value that is a substring of an unrelated action value round-trips
  **without** corrupting that action (the headline guard — must fail on today's
  code).
- A param value that appears twice in one action value is restored correctly
  for both intended and unintended sites per the chosen policy.
- Existing "parameter interpolation on write/read roundtrip" test still passes
  (no regression for the clean case).
- A short value (`"1"`) does not poison numeric content elsewhere in the plan.
