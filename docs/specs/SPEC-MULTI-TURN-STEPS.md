# Multi-Turn Step Execution — Technical Specification

**Author:** Paul Kent
**Date:** 2026-03-30
**Status:** Draft

---

## 1. Overview

Currently each test step is executed in a single AI turn: one snapshot is taken, the AI plans a list of actions, and those actions are executed to completion. This model breaks down when a step requires the AI to see intermediate page state — for example, "check how many accounts this user has from the portfolio page" requires navigating to the portfolio page before the AI can know what selectors to use there.

This spec describes a **multi-turn execution model** that allows the AI to signal when it needs to re-evaluate mid-step, enabling steps that span navigations and multiple page states.

---

## 2. Goals

- Allow a single test step to span multiple pages transparently, without requiring the test author to write intermediate navigation steps
- Keep simple single-page steps fast and cheap (no extra AI calls)
- Make the mechanism general — it applies to all steps, not just specific patterns
- All AI interactions within a multi-turn step are recorded and visible in the report and Runner UI

---

## 3. The `needs_reeval` Signal

The AI response schema gains one new optional field:

```typescript
interface AIResponse {
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;  // NEW
}
```

When `needs_reeval: true`, the AI is saying:

> "I have returned all the actions I can plan with the current page state. After executing them, take a new snapshot and ask me again — I'll plan the remaining actions then."

When `needs_reeval` is absent or `false`, execution proceeds as today: run actions, step complete.

---

## 4. Execution Flow

### Single-turn (unchanged behaviour)

```
snapshot → AI → { actions: [click #btn], needs_reeval: false }
→ execute click
→ step complete
```

### Multi-turn

```
snapshot → AI → { actions: [navigate /portfolio], needs_reeval: true }
→ execute navigate
→ take new snapshot
→ AI (continuation) → { actions: [count .account-row → as account_count], needs_reeval: false }
→ execute count
→ step complete
```

### Continuation prompt

On each re-evaluation turn after the first, the AI receives a **continuation prompt** rather than a fresh instruction prompt:

```
You are continuing the execution of a step.

Original instruction: "check how many accounts this user has from the portfolio page"

Actions completed so far (turn 1):
  - navigate to /portfolio

Variables captured so far:
  (none)

Current URL: https://app.example.com/portfolio
[DOM snapshot]
[screenshot]

What actions are needed to complete the original instruction?
Set needs_reeval: true again only if you still cannot complete the step from this page state.
```

Captured variable values from earlier turns are included so the AI has full context.

---

## 5. `count` Action

A new action type is added to support the common "how many" pattern:

```typescript
{ action: "count", selector: string, as: string }
```

Counts the number of elements matching `selector` on the current page. Stores the result as a string (e.g. `"3"`) in `resolvedParameters[as]`, making it available as `{{as}}` in later steps.

This is analogous to the `read` action but for element counts rather than element values.

---

## 6. Safeguards

### Iteration cap

A step may re-evaluate at most **5 times** (configurable). If the cap is reached without the step completing, the step fails with:

```
Step failed: multi-turn limit reached (5 turns).
Last URL: https://app.example.com/some-page
```

### `needs_reeval` on the final turn

If the AI returns `needs_reeval: true` on the last permitted turn, the step fails — the AI is not allowed to request more turns than the cap allows. The error message indicates the step needs simplifying or splitting.

---

## 7. Reporting

All AI interactions across all turns of a step are recorded in `StepResult.aiResponses`, tagged with `attemptNumber` (already exists) and a new `turnNumber` field:

```typescript
interface AiInteraction {
  // existing fields ...
  attemptNumber?: number;
  turnNumber?: number;   // NEW: 1, 2, 3, ... within a multi-turn step
}
```

The HTML report and Runner UI OutputPanel display turn badges alongside attempt badges:

```
[Turn 2]  [Attempt 1]  Planning: count .account-row
```

Single-turn steps show no turn badge (same as today).

---

## 8. Scope

This feature applies to all steps regardless of instruction content or prefix. No new YAML syntax or step prefix is introduced — the AI decides whether re-evaluation is needed based on the instruction and current page state.

The `[output: var]` prefix and auto-capture mechanism from the capture spec are orthogonal and continue to work unchanged. A `count` or `read` action in any turn of a multi-turn step stores its value into `resolvedParameters` as normal.

---

## 9. Files Affected

| File | Change |
|---|---|
| `src/ai/types.ts` | Add `needs_reeval?: boolean` to AI response type; add `'count'` to `ActionType` |
| `src/ai/prompts.ts` | Document `needs_reeval` and `count` action; add continuation prompt template |
| `src/browser/actions.ts` | Implement `count` action case |
| `src/runner/step-executor.ts` | Add multi-turn loop in `executeStepAttempt`; pass continuation prompt on turns > 1 |
| `src/report/types.ts` | Add `turnNumber?: number` to `AiInteraction` |
| `src/report/generator.ts` | Render turn badge in HTML report |
| `src/ui/renderer/components/OutputPanel.tsx` | Render turn badge in Runner UI |
