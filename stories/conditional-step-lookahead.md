# Conditional Step Lookahead

## Problem

When a test has a conditional step like "If prompted for MFA, enter the code" followed by "Wait for the dashboard to load", the AI evaluates the conditional against a single page snapshot. If the application is slow to respond (e.g. takes 30-60s to decide whether to show MFA), the AI sees no MFA prompt yet, assumes it won't appear, and moves on to waiting for the dashboard. When the MFA screen then appears, the AI is stuck waiting for a dashboard that will never load without completing MFA first.

This is a fundamental flaw in sequential step evaluation: the AI commits to a decision (skip the conditional) before the page has settled into its final state.

## Solution: Multi-Outcome Branching

Instead of evaluating conditional steps as isolated yes/no checks against a snapshot, detect when consecutive steps describe **alternative outcomes** and present them to the AI as a multi-outcome decision. The AI waits for one of several possible states to appear, then acts on whichever one materialises.

### What changes

Three capabilities need to be added:

1. **Step grouping** — detect conditional + follow-up patterns at the test runner level and group them
2. **Page stability gate** — wait for the page to settle before evaluating which outcome appeared
3. **Outcome monitoring during waits** — re-evaluate skipped conditionals when the page state changes significantly

## Design

### 1. Step Grouping (test-runner level)

Before executing steps sequentially, scan ahead to detect **conditional groups** — sets of consecutive steps where one or more are conditional and the rest represent the expected state after the condition is resolved.

**Detection heuristics** — a step is conditional if it matches patterns like:
- `If prompted for...` / `If asked to...` / `If ... appears...`
- `If there is a...` / `If you see...`
- `When prompted...` / `When asked...`

When a conditional step is detected, group it with the next non-conditional step. This group becomes a **branch point**: the system should wait for either outcome to appear rather than checking them sequentially.

New type in `src/runner/types.ts`:

```typescript
interface StepGroup {
  /** The conditional steps (e.g. "If prompted for MFA, enter code") */
  conditionalSteps: Array<{ index: number; instruction: string }>;
  /** The follow-through step (e.g. "Wait for dashboard to load") */
  continuationStep: { index: number; instruction: string };
}
```

New function in `src/runner/step-grouper.ts`:

```typescript
/**
 * Scan a list of step instructions and identify conditional groups.
 * Returns a map of step index -> StepGroup for steps that are part of a group.
 * Steps not in any group are executed normally.
 */
function identifyStepGroups(steps: string[]): Map<number, StepGroup>;
```

**Grouping rules:**
- A conditional step followed by another conditional step: both belong to the same group (multiple possible outcomes)
- A conditional step followed by a non-conditional step: the non-conditional step is the continuation (the "else" path / expected default outcome)
- Multiple consecutive conditionals share the same continuation step
- Non-conditional steps not adjacent to conditionals are not grouped

Example:
```markdown
5. If prompted for MFA, enter "{{mfaCode}}" and continue
6. If a security question appears, answer it
7. Wait for the dashboard to load
```

This produces one group: conditionals = [step 5, step 6], continuation = step 7. The system should wait for MFA prompt OR security question OR dashboard, then act accordingly.

### 2. Branched Step Execution

New function in `src/runner/step-executor.ts`:

```typescript
/**
 * Execute a group of conditional steps as a multi-outcome branch.
 * Waits for the page to settle, then asks the AI which outcome appeared
 * and executes the appropriate action.
 */
async function executeBranchedStep(
  group: StepGroup,
  totalSteps: number,
  opts: StepExecutorOptions,
): Promise<StepResult[]>;
```

**How it works:**

1. **Wait for page stability** using `diagnosePageState()`. If the page is still loading (network activity, spinners, document not complete), wait for `networkidle` + DOM stability before proceeding. Use the existing `stable` wait type logic with a configurable timeout (default: 30s from `execution.timeout`).

2. **Build a multi-outcome prompt** that presents ALL possible states to the AI in a single message. Instead of asking "did MFA appear?" then "did dashboard load?", ask:

   ```
   The following outcomes are possible after the previous action. Examine the current
   page state and determine which outcome has occurred:

   A) MFA prompt is visible — action: enter "123456" and continue
   B) Security question is visible — action: answer it
   C) Dashboard has loaded — action: none (continue to next step)

   Which outcome matches the current page state? If the page is still transitioning
   and none of these outcomes are clearly visible yet, respond with "waiting".
   ```

3. **Handle the "waiting" response** — if the AI says the page hasn't settled into any of the expected states yet, wait a short interval (2-3s), re-capture the DOM and screenshot, and ask again. Repeat up to the timeout. This is the key difference from the current approach: instead of giving up after one check, the system actively polls.

4. **Execute the matching branch** — once the AI identifies which outcome appeared, execute the corresponding step's actions normally through `executeStepAttempt()`.

5. **Return results** — mark the matched conditional step as "passed" and the unmatched conditionals as "skipped" (not "failed"). The continuation step should only be executed if none of the conditionals matched (it's the "default" path).

### 3. New AI Prompt: `buildBranchedStepMessage`

New function in `src/ai/prompts.ts`:

```typescript
interface BranchOutcome {
  label: string;        // "A", "B", "C"
  instruction: string;  // The original step instruction
  isConditional: boolean;
}

function buildBranchedStepMessage(
  outcomes: BranchOutcome[],
  domSnapshot: string,
  screenshotBase64: string | null,
  conversationHistory: string[],
  openPages?: PageInfo[],
): ChatMessage;
```

**Expected AI response format:**

```json
{
  "matched": "A",
  "actions": [...],
  "reasoning": "The MFA prompt is visible with a code input field..."
}
```

Or when the page hasn't settled:

```json
{
  "matched": "waiting",
  "reasoning": "The page shows a loading spinner, none of the expected outcomes are visible yet"
}
```

New action parser handling in `src/ai/action-parser.ts` to extract the `matched` field.

### 4. Page Change Monitoring (safety net)

Even with the multi-outcome prompt, there's still a window where the AI may have already started executing the continuation step (e.g. "Wait for dashboard") when a conditional state appears late.

Modify the `executeAction` handler for `wait` actions in `src/browser/actions.ts`:

- When executing a `wait` action that is part of a step group (the continuation step), set up a parallel `MutationObserver`-based monitor for the conditional outcomes
- If a conditional outcome appears while waiting for the continuation, **abort the wait early** and return a special result indicating that a conditional was triggered
- The step executor detects this result and falls back to executing the triggered conditional step

This requires a new field on the wait action result:

```typescript
interface ActionResult {
  success: boolean;
  error?: string;
  // ...existing fields...
  /** If set, a conditional step was triggered during the wait */
  triggeredConditional?: {
    index: number;
    instruction: string;
  };
}
```

**Implementation in `executeWait`:**
- Accept an optional `conditionalSignals` parameter: an array of CSS selectors or text patterns that represent the conditional outcomes
- Use `Promise.race` between the original wait condition and the conditional signal monitors
- If a conditional signal wins the race, return `{ success: true, triggeredConditional: {...} }`

### 5. Stability Gate Utility

New function in `src/browser/page-state.ts`:

```typescript
/**
 * Wait for the page to reach a stable state before making decisions.
 * Combines network idle detection with DOM mutation monitoring.
 * Returns the page state diagnosis once stable, or after timeout.
 */
async function waitForPageStability(
  page: Page,
  options?: {
    timeoutMs?: number;     // Default: 10_000
    quiesceMs?: number;     // How long DOM must be quiet, default: 1_000
    networkIdle?: boolean;  // Also wait for network idle, default: true
  },
): Promise<PageStateDiagnosis>;
```

This is a stricter version of the existing `stable` wait type, specifically designed for decision points rather than generic "wait for page to load" steps.

## Integration into Test Runner

In `src/runner/test-runner.ts`, the step execution loop changes:

```typescript
const stepGroups = identifyStepGroups(test.steps);

for (let i = 0; i < test.steps.length; i++) {
  const group = stepGroups.get(i);

  if (group && i === group.conditionalSteps[0].index) {
    // This is the start of a conditional group — execute as branched step
    const results = await executeBranchedStep(group, test.steps.length, opts);
    stepResults.push(...results);

    // Skip past all steps in this group (they've been handled)
    i = group.continuationStep.index;
    continue;
  }

  if (group && i !== group.conditionalSteps[0].index) {
    // This step is part of a group but not the first — already handled
    continue;
  }

  // Normal step execution (unchanged)
  // ...
}
```

## Files to Create

- `src/runner/step-grouper.ts` — step grouping logic and `identifyStepGroups()`
- `src/runner/types.ts` — `StepGroup` type (may merge into existing types file)

## Files to Modify

- `src/runner/test-runner.ts` — integrate step grouping into the execution loop
- `src/runner/step-executor.ts` — add `executeBranchedStep()` function
- `src/ai/prompts.ts` — add `buildBranchedStepMessage()` prompt builder
- `src/ai/action-parser.ts` — handle `matched` field in branched responses
- `src/browser/actions.ts` — add conditional signal monitoring to wait actions
- `src/browser/page-state.ts` — add `waitForPageStability()` utility

## Implementation Order

1. `src/runner/step-grouper.ts` — standalone, can be unit tested immediately
2. `src/browser/page-state.ts` — add `waitForPageStability()` (builds on existing code)
3. `src/ai/prompts.ts` — add `buildBranchedStepMessage()` (no dependencies)
4. `src/ai/action-parser.ts` — handle `matched` field
5. `src/runner/step-executor.ts` — add `executeBranchedStep()` wiring everything together
6. `src/runner/test-runner.ts` — integrate step grouping into the execution loop
7. `src/browser/actions.ts` — add conditional signal monitoring to wait actions (the safety net, can be done last)

## Verification

- Unit test `identifyStepGroups()` with various step patterns:
  - Single conditional + continuation
  - Multiple conditionals + continuation
  - No conditionals (passthrough)
  - Consecutive conditional groups
  - Conditional as the last step (no continuation)
- Unit test `buildBranchedStepMessage()` output format
- Integration test: mock AI responses to exercise the branched execution path, including "waiting" loop
- Manual test: run the MFA scenario that originally triggered this issue and confirm the system waits for either MFA or dashboard before deciding
