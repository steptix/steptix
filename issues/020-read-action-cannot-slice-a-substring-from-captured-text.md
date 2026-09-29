# 020 — `read` captures an element's whole text; there's no way to slice out a substring

**Status:** ✅ resolved — `pattern` field shipped on the `read` action
**Area:** [src/browser/actions.ts:692-705](../src/browser/actions.ts#L692) (`executeRead` returns the raw value), [src/browser/actions.ts:665-675](../src/browser/actions.ts#L665) (`extractValueInPage` — value/textContent, no post-processing), [src/browser/actions.ts:707-712](../src/browser/actions.ts#L707) (`executeReadMultiple`), [src/ai/types.ts:82-114](../src/ai/types.ts#L82) (`AIAction` read fields), [src/ai/action-parser.ts:314-315](../src/ai/action-parser.ts#L314) (whitelist parser — drops undeclared fields), [src/ai/prompts.ts:186](../src/ai/prompts.ts#L186) (rule 13, the `read` guidance)
**Related:** [fixtures/tools/src/regex_extract.ts](../fixtures/tools/src/regex_extract.ts) — the interim workaround (Option B), shipped as a reusable example tool with a demo at [fixtures/tests/regex-extract-demo.md](../fixtures/tests/regex-extract-demo.md). This issue is the native (Option A) replacement.
**Opened:** 2026-06-01
**Resolved:** 2026-06-02

## Resolution

Shipped the optional `pattern` field on the `read` action exactly as proposed
below (fail-hard policy). What landed:

- **[src/ai/types.ts](../src/ai/types.ts#L115)** — `pattern?: string` on `AIAction`.
- **[src/ai/action-parser.ts](../src/ai/action-parser.ts#L316)** — one passthrough line.
- **[src/browser/actions.ts](../src/browser/actions.ts#L677)** — `compileReadPattern`
  (throws on invalid) + `sliceWithReadPattern` (`m[1] ?? m[0]`, or `null` on no
  match) + `truncateForError`; applied in [executeRead](../src/browser/actions.ts#L723)
  (throws on no match) and [executeReadMultiple](../src/browser/actions.ts#L803)
  (drops non-matching elements, logs `sliced N of M`).
- **[src/ai/prompts.ts](../src/ai/prompts.ts#L188)** — rule 13b.
- **Tests:** [tests/read-pattern.test.ts](../tests/read-pattern.test.ts) — parser
  passthrough, capture-group, whole-match fallback, `attribute`+`pattern`,
  no-pattern regression, no-match fail, invalid-regex fail, `multiple` per-element
  drop, all-miss empty list, and a parse→execute end-to-end.

One refinement from the plan below: the no-match failure is **not** a special
"terminal" path — it fails on the *same* throw path as a `read` whose selector
matches nothing (bounded retry, then a hard step failure). See the revised
no-match bullet under Design decisions. No `runner-core`/Steptix change → no
extension version bump.

## Symptom (user report)

> There is a value on the UI DOM such as
> `<div>Account number: 1234 1234 1234 OIN:12345678</div>`. If I ask the AI to get
> me the account number and put it in a variable, it returns the whole string
> `"Account number: 1234 1234 1234 OIN:12345678"`. Even if I tell it the account
> number is the 3 groups of 4 digits after `"Account number:"`, it still returns
> the whole string. What can we do here?

Confirmed. This is a capability gap, not a prompting problem.

## Mechanism

The `read` action can only return an element's **entire** value/textContent:

1. **`read` post-processes nothing.** [executeRead](../src/browser/actions.ts#L692)
   runs [extractValueInPage](../src/browser/actions.ts#L665) in the page, which
   returns `el.value` (inputs) or `el.textContent.trim()` verbatim — there is no
   slicing step.
2. **The action schema has no slot for "which part."** A read `AIAction` carries
   `selector`, `attribute`, `multiple`, `as`
   ([types.ts:82-114](../src/ai/types.ts#L82)) — nothing that expresses a
   substring rule. So the user's natural-language hint ("the 3 groups of 4 after
   `Account number:`") has nowhere to land.
3. **The parser would drop it even if the AI sent one.** `parseAction` is a strict
   whitelist — it copies only known fields
   ([action-parser.ts:314-315](../src/ai/action-parser.ts#L314)) and silently
   discards anything else. So no amount of prompting gets a slice through.

Two "obvious" non-fixes don't apply here:

- **A narrower selector won't help.** The value is bare text inside one `<div>`,
  mixed with a prefix and an `OIN:` suffix. There is no child element wrapping just
  the digits, so no CSS selector can isolate them. (It *would* work if the app
  wrapped the digits, e.g. `<span data-testid="acct">…</span>` — but that's an app
  change, not always available.)
- **Better prompting alone won't help** — there is no field for the rule (point 2),
  and `read` does no post-processing (point 1).

## Interim workaround (shipped)

The [`regex_extract`](../fixtures/tools/src/regex_extract.ts) tool (Option B) gives
authors the capability today with no engine change — read the whole string, then
slice it in a second step:

```
1. Capture the account number line as {{acct_raw}}
2. [tool: regex_extract text="{{acct_raw}}" pattern="Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" out.match="account_number"]
```

It stores the first capture group (or the whole match when the pattern has no
group) and **fails the step** on an invalid/non-matching pattern. The trade-off is
an extra step per slice and a tool to keep around. Behaviour is covered by tests in
[tests/tool-end-to-end.test.ts](../tests/tool-end-to-end.test.ts) ("regex_extract:
…"). This issue is the native, one-step replacement.

## Proposed fix (Option A) — an optional `pattern` field on `read`

Give the AI a structured place to put the slice rule it already tries to express in
words: an optional regex with a capture group. The framework applies it to the
captured text and stores group 1 (or the whole match when the pattern has no group).

```json
{ "action": "read", "selector": "div.account", "as": "account_number",
  "pattern": "Account number:\\s*(\\d{4} \\d{4} \\d{4})",
  "description": "Capture the grouped account number" }
```

| captured text | pattern | stored |
|---|---|---|
| `Account number: 1234 1234 1234 OIN:12345678` | `Account number:\s*(\d{4} \d{4} \d{4})` | `1234 1234 1234` (group 1) |
| `DE89 3704 0044 …` | `^[A-Z]{2}` (no group) | `DE` (whole match) |
| `/orders/O-1007/details` (an `href`) | `/orders/([A-Z0-9-]+)` | `O-1007` (group 1) |
| `Balance: USD 0.00` | `EUR ([\d.]+)` | **step fails** — pattern matched nothing |
| anything | `(` | **step fails** — invalid pattern |
| `Account number: 1234 1234 1234 OIN:12345678` | `OIN:([A-Z]*)` | **step fails** — matched but captured empty (single read) |

### Design decisions

- **The regex runs Node-side, after capture.** Leave
  [extractValueInPage](../src/browser/actions.ts#L665) dumb; apply the pattern to
  the string returned from `.evaluate(...)` in [executeRead](../src/browser/actions.ts#L692).
  Three reasons: (a) no need to serialize a `RegExp` into the page; (b) it runs at
  execution time on the *live* value, the same guarantee `read` already gives —
  slicing the AI's DOM *snapshot* would be non-deterministic and could go stale;
  (c) it composes uniformly — `multiple` and `attribute` each just produce a
  string (or array), and the same `applyPattern(str)` slices whatever they
  produced.
- **Capture-group semantics:** group 1 if the pattern has a capturing group, else
  the whole match (`m[0]`). Covers both "I wrapped the part I want" and "the whole
  match *is* the part I want."
- **No-match → FAIL HARD (chosen policy).** When the pattern matches nothing, the
  read **fails the step** with a clear message
  (`read pattern /…/ matched nothing in "Account number: …"`). Rejected
  alternatives: returning `""` (downstream `{{account_number}}` silently becomes
  empty; the failure surfaces later, away from the cause) and returning the whole
  string (silently reproduces the exact bug this issue fixes — looks like it
  worked). Fail-hard matches the codebase's established "loud failure ≫ soft
  fallback" stance (the parser already does this for
  [missing browser labels](../src/ai/action-parser.ts#L341) and
  [assert fields](../src/ai/action-parser.ts#L398)).
  - **It fails on the same path as any other read failure (bounded retry, then a
    hard fail) — not a special "terminal" path.** *(Revised during implementation
    from the original "must be terminal" stance.)* A `read` whose *selector*
    matches nothing already throws inside `executeRead` and flows through the
    standard `withRetry` loop; a pattern non-match throws on the *same* path, so
    the two behave identically with zero special-casing in the step executor. The
    bounded retry is a feature here, not a cost: on retry the AI sees
    `read pattern /…/ matched nothing in "<actual text>"` and can correct a
    mis-escaped or under-constrained regex. (If a field is *legitimately*
    sometimes-absent, that's the one argument for an opt-in empty-string mode —
    not in scope unless a real case appears.)
- **Invalid regex → FAIL HARD too.** `new RegExp(pattern)` throwing is an AI/author
  error; fail with `read pattern /…/ is not a valid regular expression — …` rather
  than silently ignoring the pattern (which is the whole-string fallback in disguise).
  For `multiple`, an invalid pattern still fails (compiled once up front) even though
  a per-element non-match only drops that element.
- **Empty capture → also fails, for a single read.** A pattern that *matches* but
  captures the empty string (a `*`/`?`/zero-width group that matched zero chars)
  would store `""` — the exact silent-empty outcome this feature prevents — so a
  single `read` fails it with `captured an empty substring (pattern too loose)`. A
  `multiple` read KEEPS `""`: one empty among many is a legitimate list item.
  *(Surfaced by the post-build code review and fixed.)*
- **`multiple: true`:** apply the pattern per element after `evaluateAll`. Default
  to **dropping** non-matching elements and `log()`-ing `"sliced N of M"` so the
  truncation is visible (consistent with the
  [`READ_MULTIPLE_MAX`](../src/browser/actions.ts#L677) logging ethos). Keeping
  index-aligned empties is the alternative if a positional join is needed — revisit
  if a real case wants it.
- **`attribute` + `pattern`:** capture (attribute or text) **then** slice, so e.g.
  read an `href` and pull an id out of the URL. Clean because the pattern runs last.
  Note the raw strings aren't uniformly trimmed (textContent is `.trim()`ed; `value`
  / attributes are not — see [extractValueInPage](../src/browser/actions.ts#L665));
  in practice the AI writes `\s*` into the pattern, but the prompt rule should say so.
- **Safety footnote:** `new RegExp` from model output carries a theoretical ReDoS
  risk. Low concern (runs Node-side on one element's short text, not attacker
  input at scale); a length guard on the input is cheap insurance if wanted.

### Touch points (small — parser is a whitelist, so the field is one line)

1. **[src/ai/types.ts](../src/ai/types.ts#L82)** — add `pattern?: string` to
   `AIAction` with a doc comment.
2. **[src/ai/action-parser.ts](../src/ai/action-parser.ts#L314)** — one passthrough
   line next to `attribute`/`multiple`:
   `if (typeof obj['pattern'] === 'string') action.pattern = obj['pattern'];`
3. **[src/browser/actions.ts](../src/browser/actions.ts#L692)** — an `applyPattern`
   helper (build `RegExp` → fail on invalid → `exec` → fail on no match → `m[1] ?? m[0]`),
   called at the end of `executeRead` and per-element in `executeReadMultiple`.
4. **[src/ai/prompts.ts](../src/ai/prompts.ts#L186)** — a "rule 13b": when the step
   says *which part* of an element's text to capture, set `pattern` to a JS regex
   with one capture group around the wanted substring; the framework stores group 1
   (or the whole match if no group) and the step fails if it matches nothing. Keep
   it short to avoid prompt bloat; scope it to "a sub-portion" so the AI doesn't
   attach spurious patterns.

All in the **main package** — `read` execution is not in `runner-core`, so **no
Steptix extension version bump** is triggered (per CLAUDE.md the bump is only for
code bundled into a VSIX).

## Tests (shipped)

All in [tests/read-pattern.test.ts](../tests/read-pattern.test.ts):

- **Parser:** a `read` action with `pattern` survives parsing; absent `pattern`
  leaves the field undefined; a non-string `pattern` is dropped (defensive).
- **executeRead (real Playwright page):** capture-group slice (the account-number
  case); whole-match fallback (no group); `attribute` + `pattern` on an `href`
  (URL branch) and on a `data-*` attribute (plain `getAttribute` branch);
  no-pattern regression (whole value unchanged); no-match → `success: false` +
  `/matched nothing/`; invalid regex → `success: false` +
  `/not a valid regular expression/`; empty-capture → `success: false` +
  `/empty substring/`; long-text truncation marker present in the error.
- **executeReadMultiple:** pattern applied per element with non-matching elements
  dropped; empty-string captures KEPT (contrast with the single-read fail); an
  all-miss pattern yields an empty array (not an error).
- **End-to-end:** raw AI JSON → `parseAIResponse` → `executeAction` → sliced value.

The shipped `regex_extract` tool tests in
[tests/tool-end-to-end.test.ts](../tests/tool-end-to-end.test.ts) assert the same
capture-group / whole-match / fail-hard semantics on the tool path.

## Follow-ups (not blocking)

- **General `transform` action vs. `pattern`-on-read (the strategic fork).** A
  `{ "action": "transform", "from": "raw", "pattern": "…", "as": "…" }` would slice
  **any** variable — a `read`, a `count`, a tool output, or an `extract_value` from
  an API response — not just DOM reads, and would subsume the `regex_extract` tool.
  Cost: a new action type and an extra step per slice. Decision (settled with the
  user): ship `pattern`-on-`read` first (fixes the reported case ergonomically in
  one step); add a general `transform` only if a second, non-DOM use case appears.
- **Named groups / multiple groups.** `m[1] ?? m[0]` covers the common case; a
  `group` selector (numeric index or `(?<name>…)`) could come later if needed. The
  `regex_extract` tool already exposes a numeric `group` param as a reference shape.
- **All-matches extraction.** Combining `pattern` with `multiple` slices *one* value
  per element; "every match within a single element's text" (global regex) is a
  different shape and out of scope here.
