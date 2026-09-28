# 063 — Actions that can still report success having done nothing

**Status:** open / known limitation. Found by the review of the unknown-action
fix on 2026-09-29.
**Area:** [src/browser/actions.ts](../src/browser/actions.ts) (`switchFrame`,
`executeDismiss`); [src/runner/step-executor.ts](../src/runner/step-executor.ts)
(`extract_value`, the `prompt` gate, `noop`).
**Related:** the unknown-action fix in the same change (an unknown type now
fails instead of passing, and its retry no longer offers these actions), and
issue [061](061-use-ai-review-findings.md) finding 2.
**Opened:** 2026-09-29

## Summary

The unknown-action fix closed the loudest silent pass: an action type the
framework does not have used to be executed as a no-op that reported success.
A handful of *valid* actions can still end a step green without doing
anything on the page. Each has a reason to exist, so none is a bug on its own.
The risk is that a model that cannot do a step reaches for one of them, and the
step passes. The unknown-action retry no longer offers them, but an ordinary
turn still can.

| Action | What happens | Where |
|---|---|---|
| `switchFrame` | Ignored with a debug line; the per-action `frame` field replaced it | `actions.ts` around 495 |
| `dismiss` with nothing to dismiss | "No dismiss target found — continuing", and success | `executeDismiss` in `actions.ts` |
| `extract_value` | Recorded as a sub-action and skipped; extraction is left to the model's context | `step-executor.ts` around 3207 |
| `prompt` with `promptOnAmbiguity` off | Skipped, so a reply of only a `prompt` passes | `step-executor.ts` around 2480 |
| `noop` | Success by design ("nothing to do"), and a retry can end on it after a failure | the step loop |

## Proposed direction

- `switchFrame`: refuse it, like the step-loop-only types, with a message
  pointing at the `frame` field, or drop it from the vocabulary.
- `prompt` with `promptOnAmbiguity` off: fail the step with the model's
  question as the reason, the way a non-interactive run already does, instead
  of skipping it.
- `noop` on a retry: treat a retry that answers only `noop`, after an attempt
  whose action failed, as a failure rather than a pass.
- `dismiss` and `extract_value` are fine alone. They only matter when they are
  the whole reply to a step that asked for something else, which the
  first-try scoreboard being built alongside (`docs/specs/SPEC-scoreboard.md`)
  would show.

## Revisit when

The scoreboard exists: count steps whose only successful actions were one of
these, and fix the ones that actually occur first.
