# 003 — Deterministic bracket parsing for `[openBrowser …]` deferred to Phase 2

**Status:** open / deferred to Phase 2
**Area:** [src/parser/invocation-parser.ts](../src/parser/invocation-parser.ts), [src/runner/test-runner.ts](../src/runner/test-runner.ts) — step pre-parse
**Opened:** 2026-05-05

## Summary

Multi-browser actions ship as **AI-translated** step text rather than
deterministic bracket invocations. An author writes
`[openBrowser as="edge" channel="msedge"]` in their step; the AI sees
that text and emits the structured `openBrowser` action. This matches
the `openPage` precedent today, but is less robust than the deterministic
bracket parsing used by `[tool: ...]` and `[skill: ...]`.

## Why deferred

Phase 1 is about getting the primitive working — BrowserTracker,
launch/switch/close action handlers, prompt grounding. Adding a parser
for `[openBrowser ...]` / `[switchBrowser ...]` / `[closeBrowser ...]`
would have widened scope without adding to the binding-fixture's
correctness.

## Risks of the AI-translation route

Real failures we'd see in the field:

1. **AI omits a field.** Step says `[openBrowser as="edge" channel="msedge"]`,
   AI emits `{ action: "openBrowser", browserLabel: "edge" }` without the
   channel. Falls back to `chrome` — author meant Edge. Silent surprise.
2. **AI typos the label.** `[switchBrowser to="edge"]` becomes
   `{ action: "switchBrowser", browserLabel: "Edge" }`. Fails loudly via
   the resolved policy ("No browser registered as Edge — known: edge,
   default"), so this one's noisy at least.
3. **Re-emit on retry.** A flaky turn triggers retry; AI re-emits the
   same `openBrowser`. `BrowserTracker.add` rejects duplicate labels —
   loud failure, recoverable.
4. **Cross-step drift.** AI forgets which browser is active across many
   turns. The test-info block now surfaces `Active browser: <label>` so
   this should be rare, but isn't impossible.

## What Phase 2 would look like

Extend `[…]` step pre-parsing in test-runner (alongside `INPUT_STEP_PATTERN`,
`INTERACTIVE_STEP_PATTERN`, `OUTPUT_STEP_PATTERN`) to recognise
`[openBrowser ...]` / `[switchBrowser ...]` / `[closeBrowser ...]` and
dispatch directly to step-executor's action handlers — no AI round-trip.
The grammar overlaps with `parseInvocation` (already supports `as=...`,
`channel="..."`, bare scalars), so most of the parsing work is already
in `invocation-parser.ts` — just needs a new prefix branch and a
glue-step type.

Estimated cost: ~100 lines of code + tests, ~half a day. Saves an LLM
turn per browser action and removes the mistranslation risk above.

## Decision

Phase 2. Only ship if a real test starts hitting one of the failure modes
above, **or** if a user authoring multi-browser tests asks for it.

The mitigation in the meantime: the prompt rule (rule 18c in
[prompts.ts](../src/ai/prompts.ts)) is explicit about the field shape,
and the test-info block grounds the AI in which browsers exist.
