# State-Aware Retry Logic

## Context

When a UI action fails (e.g., selector not found), the retry system currently only tells the AI "this selector failed, try a different one." But the real issue is often that the page has changed state — it navigated after a click, it's still loading, or an error modal appeared. The AI needs to **diagnose where the application is** before deciding what to do, not just try different selectors blindly.

## Changes Overview

3 files modified, 1 new file:

### 1. New: `src/browser/page-state.ts` — Page state diagnosis utility

A lightweight function `diagnosePageState(page)` that runs a single `page.evaluate()` to detect:
- **Loading indicators**: visible `.spinner`, `.loading`, `[aria-busy="true"]`, `.skeleton`, `[role="progressbar"]`, `.loader` elements, or text like "Loading..."
- **Error overlays**: visible `[role="alert"]`, `.toast-error`, `.alert-danger`, error dialogs
- **Modals/dialogs**: visible `[role="dialog"]`, `[role="alertdialog"]`, `.modal`
- **Document readyState**: whether the page is still loading

Returns a `PageStateDiagnosis` object with `{ url, title, isLoading, loadingIndicators[], hasErrorOverlay, errorMessages[], hasModal, documentLoading }`. All detection happens in a single evaluate call for speed (<50ms).

### 2. Modify: `src/ai/prompts.ts` — Richer retry context

**Expand `PriorFailureContext`** (line 250) with new optional fields:
- `completedActions?: Array<{ action: string; description: string }>` — what succeeded before the failure
- `startUrl?: string` — URL at start of the failed attempt
- `failureUrl?: string` — URL at moment of failure
- `navigated?: boolean` — whether the URL changed (action may have partially succeeded)

**Add `RetryDiagnostics` interface:**
```typescript
{ failures: PriorFailureContext[]; pageState?: PageStateDiagnosis; attemptNumber: number }
```

**Rewrite `buildRetryContext()`** (line 265) to accept `PriorFailureContext[] | RetryDiagnostics` and generate a state-aware prompt with sections:
1. **What happened** — actions that succeeded, then which action failed and why
2. **Page state changed** — if URL navigated, warn the AI not to repeat completed actions
3. **Current page state** — loading spinners detected? error overlays? modals?
4. **Retry instructions** — assess the page state first, wait if loading, dismiss modals, don't blindly repeat

**Update `buildContinuationMessage` signature** (line 290) — widen `completedActions` param type to `Array<{ action: string; description: string; selector?: string }>` (body unchanged, it only reads `.description`).

### 3. Modify: `src/runner/step-executor.ts` — Capture richer failure state

**Track starting URL** — add `const attemptStartUrl = page.url()` at top of `executeStepAttempt()` (after line 194).

**Widen `allCompletedActions` type** (line 192) to `Array<{ action: string; description: string; selector?: string }>` and update the push (line 531) to include action type and selector.

**Enrich failure capture** (lines 513-526):
- Remove the `if (result.failedSelector)` guard — always collect failures
- Include `completedActions` (from prior turns + current turn before failure)
- Include `startUrl`, `failureUrl`, `navigated` fields

**Run page diagnosis before retry** (after line 220):
- If `attemptNumber > 1 && currentTurn === 1`, call `diagnosePageState(page)`
- If loading indicators detected, auto-wait for `networkidle` (up to 5s) before capturing DOM
- Pass diagnosis into `buildRetryContext()` as `RetryDiagnostics`

**Update `buildRetryContext` call site** (line 273):
```typescript
const retryDiagnostics = priorFailures.length > 0
  ? { failures: priorFailures, pageState: pageDiagnosis, attemptNumber }
  : undefined;
const retryHint = retryDiagnostics ? buildRetryContext(retryDiagnostics) : '';
```

## Implementation Order

1. Create `src/browser/page-state.ts` (standalone)
2. Expand types in `src/ai/prompts.ts` (backward-compatible additions)
3. Rewrite `buildRetryContext()` in `src/ai/prompts.ts`
4. Update `src/runner/step-executor.ts` (failure capture, diagnosis, wiring)

## Verification

- Run existing tests: `npm test`
- Manual test with a scenario that triggers retry (e.g., a slow-loading page where the first attempt times out) and verify the retry prompt now includes state diagnosis
- Check that the report HTML still renders correctly with the enriched retry data
