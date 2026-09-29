# 013 — Secret-name masking is implemented in five places with two different regexes

**Status:** open / low priority
**Area:** [runner-core/src/repl.ts](../runner-core/src/repl.ts), [src/parser/parameters.ts](../src/parser/parameters.ts), [testbench-monaco/src/webview/lib/variables-panel.js](../testbench-monaco/src/webview/lib/variables-panel.js), [steptix-vscode/src/webview/lib/variables-panel.js](../steptix-vscode/src/webview/lib/variables-panel.js) — secret detection
**Related:** Variables panel rendering (Steptix), CLI log redaction
**Opened:** 2026-05-19

## Summary

The decision "is this variable a secret?" is made by regex-matching the
variable **name**. That single decision is implemented five times across
the codebase, with **two different regex strings**, and they will drift
silently the next time someone updates one without the others.

The user-visible effect is small today — masking is a defence-in-depth
display concern, not a correctness one — but the duplication is
load-bearing on developer attention every time a new "secret-shaped" name
needs to be added (e.g., `bearer`, `credential`, `passphrase`,
`refresh_token`).

## The five sites

| # | File:line | Regex | Output |
|---|---|---|---|
| 1 | [runner-core/src/repl.ts:121-125](../runner-core/src/repl.ts#L121-L125) `maskIfSecret` | `password\|secret\|token\|apikey\|api_key` | up to 8 `*`, `(empty)` for empty |
| 2 | [testbench-monaco/src/webview/lib/variables-panel.js:115-119](../testbench-monaco/src/webview/lib/variables-panel.js#L115-L119) `maskIfSecretInline` | `password\|secret\|token\|apikey\|api_key` | up to 8 `*`, `(empty)` for empty |
| 3 | [steptix-vscode/src/webview/lib/variables-panel.js:139-144](../steptix-vscode/src/webview/lib/variables-panel.js#L139-L144) `maskIfSecretInline` | `password\|secret\|token\|apikey\|api_key` | up to 8 `*`, `(empty)` for empty |
| 4 | [src/parser/parameters.ts:82](../src/parser/parameters.ts#L82) `isSecret` (CLI prompt hint) | `password\|secret\|token\|key` | hides input via `(input hidden)` label |
| 5 | [src/parser/parameters.ts:149-154](../src/parser/parameters.ts#L149-L154) `maskSecret` (log output) | `password\|secret\|token\|key` | literal `***`, `(empty)` for empty |

Stale documentation in [testbench-monaco/stories/interactive-input-and-fsd.md:246](../testbench-monaco/stories/interactive-input-and-fsd.md#L246)
and its native twin still claim the regex is `password|secret|token` —
neither matches the implementation any more. A documentation hazard but
not load-bearing.

## What the divergence means concretely

A variable named simply `key` (e.g., `account_key`, `lookup_key`,
`primary_key`):

- The **CLI prompt** treats it as a secret — input is described as hidden
  ([src/parser/parameters.ts:82](../src/parser/parameters.ts#L82)).
- The **CLI debug log** masks the value as `***`
  ([src/parser/parameters.ts:150](../src/parser/parameters.ts#L150)).
- The **Steptix Variables panel** and **Steptix output log** show the
  full value, because the runner-core regex requires `apikey`/`api_key`,
  not bare `key`.

So a user running a test with `account_key` in `## Parameters` sees a
masked debug line in their terminal but a clear-text value in the
Variables panel. Confusing rather than dangerous.

## Why we accepted this initially

Three independent reasons converged:

1. **Webview can't import Node modules.** The webview JS bundle is
   sandboxed; it can't `require('steptix-runner-core')`. The
   two webview copies were hand-mirrored from runner-core so the panel
   could render the right masking without a host round-trip.
2. **Two Steptix variants ship in parallel.** `testbench-monaco` and
   `steptix-vscode` share no source — `runner-core` is the only common
   ground — so the webview copy got duplicated again.
3. **`parameters.ts` lives server-side** in `src/parser/`. It was written
   before `runner-core` existed as an extraction target, and its
   `maskSecret`/`isSecret` helpers were never moved.

The drift wasn't a decision; the canonical regex picked up `apikey` and
`api_key` in [commit history TBD], but `parameters.ts` wasn't updated to
match.

## Fix sketches

**Option 1 — single source in `runner-core`, mirrored at build time.**

`runner-core/src/repl.ts` already owns the canonical version. Add a
build step that emits a self-contained `dist-webview/secret.js` exporting
the same function, and have both webview bundles import from there
rather than maintain hand-copies. `src/parser/parameters.ts` simply
imports `maskIfSecret` from runner-core.

Cost: one new build target in `runner-core`, two import paths to
rewire. Benefit: literally one regex string in the whole repo.

**Option 2 — keep three copies but lockstep them with a test.**

Add a single test that imports the four functions (and re-evaluates the
two regexes textually) and asserts they all match the same patterns
against a fixed test corpus. Fails CI the moment they drift.

Cost: one test, ~30 lines. Benefit: no refactor risk. Doesn't actually
deduplicate — just stops silent drift.

**Option 3 — make the secret check policy-driven.**

Expose the regex (or a more sophisticated rule set) via config — e.g.
`logging.secretNamePattern` — so users can extend it without editing the
codebase. Necessary if we ever start adding industry-specific tokens
(`pan`, `cvv`, `iban`, …) and don't want to keep growing the default.

Cost: config plumbing across CLI + server + extensions. Benefit:
correctness for users with non-default conventions.

## Recommendation

Option 2 first — cheap and immediate. Lock the four implementations
against drift with one test, then revisit Option 1 (true single source)
the next time the regex is genuinely wrong (e.g., when adding `bearer`
or `passphrase`) so we're not refactoring just to refactor.

Option 3 is interesting but speculative — leave it as "future work" and
revisit when a real user asks for it.

## Tests this would need

For Option 2:

- Fixture array of names: `password`, `userPassword`, `secret`, `token`,
  `accessToken`, `apikey`, `api_key`, `MY_API_KEY`, `username`, `email`,
  `pin`, `auth_header`, `key`, `account_key`.
- For each, assert all four detection sites agree on whether it's a
  secret. The test would fail today on bare `key` — that failure IS the
  documentation of the divergence and forces the resolution to be
  conscious.

For Option 1:

- The current `runner-core/tests/repl.test.js` `maskIfSecret` cases stay.
- New: `dist-webview/secret.js` imported and exercised the same way.
- The webview bundlers (esbuild for steptix-vscode, the monaco
  variant's bundler) include the file without modification.

## Discovered while

User asked how the framework decides which parameter is a password
versus not — answering the question surfaced that "the framework"
actually has two different answers depending on who you ask.

## Revisit when

- Adding a new secret-shaped name (`bearer`, `passphrase`, `cvv`, …).
- A user reports masking inconsistency between the CLI output and the
  Steptix Variables panel.
- Refactoring `src/parser/parameters.ts` for any other reason — fold the
  consolidation in then.
