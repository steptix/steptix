# 023 — Step cache: parameter reverse-interpolation corrupts cached actions on substring collisions

**Status:** open / medium-high priority (silent data corruption, not a loud failure) — **resolution decided, see [Resolution](#resolution-decided-ai-emits-tokens-option-a) below; not yet implemented**
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

## Fix sketches (considered)

**Option A — the AI emits the `{{token}}` directly; no reverse-interpolation.**
Instead of fully resolving the instruction before the AI call and then *guessing*
the placeholder positions back out of the result, give the AI the token **and**
its value, and have it echo the `{{token}}` in any action field whose value it
derived from a parameter. The framework substitutes the real value at execution
time. This removes the blind `replaceAll` entirely — the provenance the cache was
trying to reconstruct is supplied by the one party that actually has it (the AI
composed the value, so it knows which `dev` is the `env` and which is the letters
in "devices"). **Chosen.** See [Resolution](#resolution-decided-ai-emits-tokens-option-a).

**Option B — word-boundary / delimiter-aware replacement.** Only replace
occurrences bounded by non-alphanumeric delimiters, so `dev` inside `devices` is
left alone. **Rejected** — heuristic, not airtight: it changes the *direction* of
failure toward riding-the-cache (fewer binds), which sacrifices correctness for
partial-tokenization and abutting values (`dev-prod`, non-word values). With
correctness paramount we cannot adopt a mitigation that can ride a stale value.

**Option C — detect ambiguity, fall back to value-binding.** When a parameter's
value can't be safely parameterized, **don't** parameterize it — bind the concrete
value into the cache identity so a value change busts the cache. **Adopted as the
no-guess fallback** under the Resolution: it never guesses placement, so its worst
case is a lost cache hit (re-ask the AI), never a corrupted action.

---

## Resolution (decided): AI emits tokens (Option A) + detect-and-bind fallback (Option C)

**Guiding principle — correctness is paramount.** The cache must never replay an
action different from what would have been executed live for the current
parameter values. Every ambiguous case resolves toward *busting the cache*
(re-ask the AI), never toward riding a possibly-stale value. Lost cache hits are
acceptable; a single corrupted/stale replayed action is not.

### Mechanism

1. **Annotated instruction → AI.** Stop fully resolving the instruction at
   [test-runner.ts:457](../src/runner/test-runner.ts#L457). Send the token form
   plus a values block:

   ```
   ## Current Step
   Navigate to {{url}}/devices

   ## Parameter Values
   The step text and the page contain these parameter-derived values. When an
   action field's value is DERIVED FROM one of these parameters, put the
   {{token}} in that field — NOT the literal value. The framework substitutes
   the real value at execution time. Use the literal value only for reasoning
   (e.g. to locate the right element in the DOM).
   - {{url}}  = "https://dev.example.com"
   - {{code}} = "1"
   ```

   The AI still sees real values in the DOM snapshot (we cannot tokenize the
   page), so a selector like `tr:has-text("{{email}}")` is reasoned against the
   real `paul@example.com` but emitted with the token.

2. **AI emits tokens** in any param-derived field:
   `{ "action": "navigate", "url": "{{url}}/devices" }`.

3. **Execute (live path): forward-interpolate, then run.** Today the live path
   executes the AI's literal value directly; now it substitutes tokens first.
   This unifies the live and cached paths — both consume the same tokenized form.

4. **Cache write: store the AI's tokenized action verbatim.** Delete
   `reverseInterpolate` / `reverseInterpolateString`. There is no string-replace
   guessing, so the substring collision cannot occur.

5. **Cache read: forward-interpolate** (existing
   [forwardInterpolate](../src/cache/step-cache.ts#L321)), extended to every
   param-bearing field (see below).

### Two supporting fixes this exposes

- **Interpolate ALL param-bearing fields, not just `value`.** Today
  `forwardInterpolate`/`reverseInterpolate` touch only `action.value`
  ([step-cache.ts:284](../src/cache/step-cache.ts#L284)), so a param value landing
  in `url`, `selector`, `condition`, `expected`, `path`, `filePath`, or inside
  `body`/`apiHeaders` is *already* silently baked into the cache as a literal —
  the same correctness bug, just outside the one field the issue first noticed.
  Define one shared `INTERPOLATABLE_FIELDS` list used by both the forward pass and
  the detector, so the two can never drift.

- **Fail loud if a token survives interpolation.** `interpolate`
  ([parameters.ts:92](../src/parser/parameters.ts#L92)) matches `{{\w+}}` and
  currently leaves an unknown token in place with only a `logger.warn`. With
  tokens now load-bearing at execution, a mis-emitted or unknown token
  (`{{teh_url}}`) would otherwise execute as the literal string `"{{teh_url}}"`.
  Before executing any action, assert no `{{…}}` remains in an interpolatable
  field; if one does, fail the step loudly. (Note: `\w+` does not match dotted
  keys like `{{data.url}}` — tokens must be simple identifiers, or `interpolate`'s
  regex must be widened. Examples below use simple keys.)

### The detection predicate (airtight, correctness-first)

Even with the AI emitting tokens, it can **fail to tokenize** — emit a literal
value where a `{{token}}` belonged, or tokenize one occurrence and bake another
("partial tokenization"). We must catch every such case and value-bind it. We do
**not** re-run a string-replace to "repair" it (that is the rejected Option B and
would reintroduce the collision). We only *detect* and *bind*.

Detection works by **token-blanking then literal-scanning** — conservative by
construction:

```
INTERPOLATABLE_FIELDS = [selector, value, url, filePath, condition,
                         expected, path, key, ...JSON(body), ...JSON(apiHeaders)]

classify(actions, resolvedParams):           # resolvedParams filtered to v.length > 0
  bind = {}                                   # param key -> value to bind
  for action in actions:
    for field in INTERPOLATABLE_FIELDS(action):
      s        = field value (string)
      sBlanked = replace every {{k}} (for k in resolvedParams) in s with U+0000
      for (k, v) in resolvedParams:
        if sBlanked.includes(v):              # a literal v survives that NO token explains
          bind[k] = v                         # -> the AI baked it in; bind it
  return bind
```

Why blanking-then-scanning is exactly right:

- We remove every legitimate token-driven occurrence first (blank the `{{k}}`s),
  so **any remaining literal `v` is a baked-in literal** the cache would replay
  unchanged when the value changes → must bind. This catches partial tokenization
  (`{{env}}.example.com/dev-prod` with `env=dev`: blanking `{{env}}` leaves
  `dev-prod`, scan finds `dev` → bind `env`).
- It **never under-binds** (the dangerous direction). A `v` that only ever appears
  via a token disappears after blanking and is correctly *not* bound. A `v`
  composed across a token boundary (`ab{{j}}c`, `v="abc"`) never appears
  contiguously in the executed output either, so not binding it is correct.
- It **may over-bind** (the safe direction) for short values that are incidental
  substrings: `env=dev` tokenized cleanly as `{{env}}/devices` still binds `env`
  because `dev` survives inside `devices`. Accepted: this only costs a cache hit
  (the step re-asks the AI on a value change), never correctness. A fast-path of
  "values shorter than N chars always bind" is a reasonable optimization of this.

### The fallback: per-step value-binding (not a global rehash)

Binding is **per step**, so one ambiguous step doesn't bust the whole test cache.
Store the bound pairs in the step file and compare on read:

```jsonc
// step-<key>.json
{
  "turns": [ { "actions": [ /* tokenized */ ], ... } ],
  "boundParams": { "env": "dev" }   // present only when classify() bound something
}
```

On `read`: after loading, for each `k` in `boundParams`, if
`resolvedParams[k] !== boundParams[k]` → return `null` (cache miss → re-ask the
AI). This is Option C scoped to the step, with no placement guessing anywhere.

**Self-healing:** a one-off tokenization miss on run 1 binds the value; the next
value change forces a miss → re-ask → the AI may tokenize correctly this time →
the rewrite drops `boundParams` and the step rejoins the params-ride-cache path.

### Worked examples

**How to read these examples (notation legend).** Each example is one trace of a
single step through the new flow. The lines mean:

- **`AI emits →`** — the action object the AI returns on a cache-*miss* run (when
  the AI is actually called). Under the new design we send it the `{{token}}`
  *and* the value and tell it to put the **token** in any field it derived from a
  parameter. So the token here is what the AI chose to write.
- **`blank {{k}} → … ; scan for "v" → …`** — the **detection predicate** running
  at cache-*write* time, checking whether the AI secretly baked the literal value
  in. *blank* = erase every known `{{token}}` from the field, leaving only the
  literal text the AI typed (shown with the token's spot emptied). *scan for `"v"`*
  = search that leftover literal text for the resolved parameter value `v`.
  `absent` = the value only existed via the token (good). `FOUND` = a literal copy
  of the value is baked into the action (the AI failed to fully tokenize).
- **`classify → bind = {…}`** — the verdict. `bind = {}` (empty) → nothing baked,
  the step **rides the cache** (one plan serves any value). `bind = { k: v }` → a
  baked literal was found, so param `k` is **value-bound** to `v`.
- **`stored →`** — exactly what gets written to the step's cache file: the AI's
  action **verbatim** (token intact, no reverse-interpolation), plus a
  `boundParams` map *only* when `bind` was non-empty.
- **`run 2 …`** — a *later* run with a different value for that parameter. `HIT`
  = cache served (no bound param changed) → `forward-interp` substitutes the
  current value into the stored token. `MISS` = a bound param's value changed →
  cache busts → the AI is re-asked (correct, at the cost of one AI call). `✅` =
  ends with the correct executed value; the old behaviour is shown for contrast.

Param: `url = "https://dev.example.com"`, step `Navigate to {{url}}/devices`.

**(1) Clean ride — AI tokenizes.**
```jsonc
AI emits  → { "action": "navigate", "url": "{{url}}/devices" }
blank {{url}} → " /devices"; scan for "https://dev.example.com" → absent
classify  → bind = {}                       // rides the cache
stored    → { "url": "{{url}}/devices" }
run 2 url="https://qa.example.com" (HIT) → forward-interp → https://qa.example.com/devices  ✅
```
Line by line: the AI **kept the token** in `url` rather than baking the value;
the detector **blanked** the token, leaving only the literal `/devices`, and
**scanned** it for the value `https://dev.example.com` — absent, so nothing was
baked; `classify` therefore binds nothing and the step **rides the cache**; the
action is **stored verbatim** (token intact, no `boundParams`); and on a later run
the cache **hits** and `forward-interp` substitutes the new value into the token,
leaving `/devices` untouched.

Contrast — the OLD reverse-interpolation stored
`https://{{url}}.example.com/{{url}}ices` (it blindly replaced the `dev` inside
"devices" too) and on run 2 produced the corrupted `https://qa.example.com/qaices`.
The new flow can't do that: the token sits only where the AI put it.

**(2) Over-bind (safe false positive) — short value.** `env = "dev"`, step
`Open the {{env}} dashboard`, AI tokenizes cleanly:
```jsonc
AI emits  → { "action": "navigate", "url": "{{env}}/devices" }
blank {{env}} → " /devices"; scan for "dev" → FOUND inside "devices"
classify  → bind = { env: "dev" }           // conservative: bind
stored    → { "url": "{{env}}/devices" }, boundParams: { env: "dev" }
run 2 env="qa" → boundParams mismatch → MISS → re-ask AI (correct, costs one call)
```

**(3) Genuine miss — AI bakes the literal.**
```jsonc
AI emits  → { "action": "navigate", "url": "https://dev.example.com/devices" }   // no token
blank (none) → unchanged; scan for "https://dev.example.com" → FOUND
classify  → bind = { url: "https://dev.example.com" }
run 2 url="https://staging.dev.example.com" → mismatch → MISS → re-ask (no stale replay)  ✅
```

**(4) Partial tokenization — caught.** `env = "dev"`:
```jsonc
AI emits  → { "action": "navigate", "url": "{{env}}.example.com/dev-prod" }
blank {{env}} → " .example.com/dev-prod"; scan for "dev" → FOUND in "dev-prod"
classify  → bind = { env: "dev" }           // would-be stale "dev-prod" can't ride
```

### Migration

Bump `SCHEMA_VERSION` (currently 4,
[step-cache.ts:13](../src/cache/step-cache.ts#L13)) → 5. Old entries were written
by the reverse-interpolation path (string-guessed tokens, no `boundParams`) and
must be discarded; the existing meta check clears them.

### Open questions (remaining)

1. **Selector tokenization reliability.** Pass-through fields (`navigate.url`,
   `type.value`, `select.value`) are easy for the AI. Selectors and `assert`
   `expected`/`condition` require "reason with the value, emit the token" and are
   where misses will concentrate. Acceptable (misses bind, not corrupt) but worth
   measuring; the system-prompt rule must be explicit and exemplified.
2. **Assertion-code cache.** `writeAssertion`/`readAssertion`
   ([step-cache.ts:142-185](../src/cache/step-cache.ts#L142)) use
   `reverseInterpolateString` over generated JS. Same fix shape (AI emits tokens
   in the code, or value-bind), tracked here so it isn't missed.
3. **Captured values (`read … [store as: x]`).** Page-derived, only known at
   runtime, and already flow as `{{x}}` into later steps. Confirm the detector
   treats them identically to declared `## Parameters` (it should — they're just
   entries in `resolvedParams` at write time).
4. **Length fast-path threshold.** Is "always bind values shorter than N chars" a
   useful optimization of the over-bind case, and what is N (covering `"1"`,
   `"US"`, `"on"`)?

## Tests this would need

- **Headline guard (must fail on today's code):** a param value that is a
  substring of an unrelated action value round-trips without corrupting that
  action.
- **Clean ride:** a tokenized action with a non-substring value rides the cache
  across a value change and forward-interpolates correctly; no `boundParams`
  written.
- **Over-bind:** a short value that is an incidental substring (`env=dev` in
  `devices`) is bound; a value change produces a MISS, not a corrupted replay.
- **Genuine miss:** an action where the AI baked the literal value (no token) is
  bound; a value change produces a MISS.
- **Partial tokenization:** value appears twice, one tokenized and one baked →
  the param is bound (no stale ride).
- **All-fields:** a param value in `url` / `selector` / `condition` / `expected`
  is interpolated on read (regression for the value-only limitation).
- **Fail-loud guard:** an action reaching execution with an unresolved `{{token}}`
  in an interpolatable field fails the step rather than executing the literal.
- **Self-heal:** after a bound step, a re-ask that tokenizes correctly drops
  `boundParams` and the step rejoins the ride-the-cache path.
- Existing "parameter interpolation on write/read roundtrip" test still passes.

## Review findings (adversarial design review — fold into implementation)

A design review pass against the real code found the architecture sound (AI emits
tokens + delete blind reverse-interpolation genuinely removes the collision
class) but surfaced concrete gaps. Grouped by how they affect the plan. **Treat
the must-fix items as blocking; the integration items must each be resolved before
coding; the accepted-limitations correct over-claims in the text above.**

### Must-fix before implementation

- **MF1 — Detector must scan *verbatim* baked literals only, and we must say so.**
  The detector catches a baked param value only when it appears in the tokenized
  string **exactly** as the resolved value (case, whitespace, punctuation). If the
  AI fails to tokenize *and* bakes a **transformed** copy — lowercased URL host,
  trimmed/recased text, a normalized number — `sBlanked.includes(v)` misses it and
  the param is **not** bound → a value change later replays the stale transformed
  literal. This is a genuine **under-bind** (the catastrophic direction), so the
  earlier "never under-binds" claim is too strong: it holds only for verbatim
  bakes. Mitigations: (a) keep the AI-tokenization the primary guarantee and treat
  the detector as a verbatim backstop; (b) reduce transform surface by NOT echoing
  case-fragile values into the prompt in a normalized form; (c) consider also
  scanning a small set of canonical transforms (lowercase) of each value. Record
  honestly: transformed bakes are a residual risk, not covered.

- **MF2 — Values containing `{{`/`}}` and the U+0000 sentinel break the detector
  and the guard.** Captured `read` values store arbitrary page text into
  `resolvedParameters`; a page can legitimately display `{{mustache}}` or contain
  control chars. Two breakages: (1) the U+0000 blanking sentinel collides if any
  value contains U+0000 → scan mis-fires in either direction (incl. under-bind);
  (2) the fail-loud guard can't tell "a token I failed to resolve" from "literal
  braces that came from page data." Fixes: blank by **span-tracking** (record the
  index ranges that `interpolate` would rewrite and scan only outside them) rather
  than an in-band sentinel; and make the guard fire only on tokens whose key is a
  **known param that failed to resolve**, never on arbitrary `{{…}}` text.

- **MF3 — `interpolate`'s `{{\w+}}` regex vs. real key shapes + no escape.**
  `interpolate` ([parameters.ts:93](../src/parser/parameters.ts#L93)) matches only
  `[A-Za-z0-9_]+`, so namespaced/hyphenated data-file keys (`search-engine.query`)
  never resolve — and the new fail-loud guard would then fail **every** test using
  such a key. Either widen the regex to `[\w.\-]+` (and audit other callers) or
  drive the guard from the known-key set, not a blind `{{…}}` scan. Separately,
  there is **no escape** for a test that legitimately types/asserts literal
  `{{…}}` text (templating-UI tests): the guard would fail those steps. Define an
  escape (e.g. `\{\{`) honored by both `interpolate` and the guard.

### Integration points that must be resolved (not yet specified)

- **IP1 — Where live-path forward-interpolation is inserted, and the assert
  codegen path.** Today forward-interpolation runs **only** in `StepCache.read`;
  fresh AI actions dispatch unmodified. The "interpolate then execute" step must
  be inserted on the fresh-action path too (in the step executor, both the
  cache-miss and branched paths). Critically, `assert` `condition`/`expected` feed
  `fingerprintAssertion` and `buildAssertionCodePrompt`
  ([prompts.ts:354](../src/ai/prompts.ts#L354)); if those now carry tokens they
  must be forward-interpolated **before** fingerprint + codegen — which makes the
  assertion-code fingerprint value-dependent again (busts on value change). That
  is acceptable (correctness over hits) but must be decided explicitly; it ties
  IP1/IP3 together.

- **IP2 — Predicate-mode asserts depend on a fully-substituted instruction.**
  `against: "predicate"` ([prompts.ts:169](../src/ai/prompts.ts#L169),
  [types.ts:177-185](../src/ai/types.ts#L177)) is contractually "both sides
  already substituted into `condition`; nothing to fetch." Sending tokens instead
  of resolved values and asking the AI to *echo the token* in `condition` would
  produce `"{{order_count}} is at least 5"` and generate JS comparing the literal
  string — silently breaking every predicate assertion. Predicate `condition` must
  be **excluded from the echo-the-token rule** (the AI substitutes the literal
  there), or `condition` must be forward-interpolated before codegen. Pick one and
  state it.

- **IP3 — Assertion-code cache (`writeAssertion`/`readAssertion`).** These
  reverse-interpolate generated JS today ([step-cache.ts:171](../src/cache/step-cache.ts#L171));
  deleting `reverseInterpolateString` leaves stale assertion code that bakes the
  old expected literal (`textContent === "Laptop"`) and replays as a silent
  wrong-pass/wrong-fail on a value change. Covered **only if** IP1's
  "interpolate condition/expected before fingerprint" decision is taken (the
  fingerprint then busts naturally). Until decided, this is an open hole, not a
  tracked-and-safe one.

- **IP4 — Field-set reconciliation: `frame`, `page`, `as`, `description`.** The
  shared `INTERPOLATABLE_FIELDS` list must explicitly include `frame` and `page`
  (selector/identifier-like, can carry param values) — omitting them means they
  are neither interpolated nor detected → under-bind. And the AI, told to "echo
  the token," may put `{{…}}` into non-interpolatable fields: `as` (a variable
  **name** — `{{…}}` is not a valid identifier and corrupts later lookups),
  `description`, `reasoning`. The detector should scan **all** string fields;
  the prompt rule must scope "echo the token" to value-bearing fields and forbid
  it in `as`/`description`.

- **IP5 — `body`/`apiHeaders` serialization contract.** `body` is `unknown`
  ([types.ts:71](../src/ai/types.ts#L71)) — number/bool/nested. Define how tokens
  survive in a typed `body` (a token must sit inside a JSON string value, never
  bare), how the detector scans it (walk leaves vs. scan serialized blob, mind
  JSON escaping of quotes), and how read-side reconstruction keeps it typed.
  Today nothing interpolates `body`; this is net-new surface.

- **IP6 — Branched steps.** `executeBranchedStep`
  ([test-runner.ts:401](../src/runner/test-runner.ts#L401)) actions appear to
  bypass the step cache. Confirm, and ensure all-fields forward-interpolation +
  the fail-loud guard are applied on that path too, or branched actions execute
  raw tokens.

### Accepted limitations / corrections to the text above

- **AL1 — "Token-expansion forms a value" is NOT a corruption.** A reviewer flag
  that `{{host}}/v1` can produce a string equal to some other param's value was
  examined and **rejected as a correctness hole**: the template `{{host}}/v1`
  never baked that other param, rides `host` correctly, and the cache replays
  exactly what the live run would produce for the same inputs. It is a
  tokenization-*quality* question, not stale/corrupt replay. No detector change.

- **AL2 — Self-healing does NOT apply to over-bound incidental substrings.** The
  headline over-bind example (`env=dev` inside `devices`) re-binds on **every**
  run because correct tokenization still leaves `dev` in `devices`. It is
  correctness-safe but never rejoins the ride-the-cache path — it re-asks the AI
  on each value change. The "self-heal" claim holds only for genuine one-off
  tokenization misses, not for incidental-substring over-binds. Reword the
  self-heal note accordingly (and this is the strongest argument for the
  short-value length fast-path: stop pretending those will ever ride).

- **AL3 — Single-space / whitespace values.** A value of `" "` passes the
  `v.length > 0` filter and `.includes(" ")` matches nearly everything → near-total
  over-bind (safe, but caching collapses). Add a guard (treat all-whitespace
  values as always-bind, or exclude them from the scan with a logged note).

- **AL4 — Test/cleanup completeness.** Deleting `reverseInterpolate` /
  `reverseInterpolateString` makes the longest-first sort
  ([step-cache.ts:280](../src/cache/step-cache.ts#L280)) dead code and obsoletes
  the existing reverse-interpolate **unit** tests — rewrite, don't just add. The
  all-fields `forwardInterpolate` rewrite must preserve the "return same object
  reference when unchanged" contract the current unit tests pin. Assertion files
  (`step-<key>-asserts.json`) are cleared by the whole-dir wipe on schema mismatch
  (no independent version) — fine, but add a test.
