# SPA-aware waits: post-action settle + AI-chained waits

## Context

UI automation on modern applications has two dominant waiting problems:

1. **SPAs break `networkidle`.** Single-page apps keep long-lived websockets, analytics beacons, and polling fetches open. `page.waitForLoadState('networkidle')` times out even when the user-visible page has been stable for seconds. The framework's old `waitForPageStability` spent up to ~6s on `networkidle` before falling through to DOM quiescence — pure dead time on every turn for most SPAs.
2. **Waiting is emergent, not explicit.** The "one action per turn" rule meant the AI would click a button, observe, then decide whether to wait. A step like "click Login and wait until the OTP page loads" took N turns of polling (each a full DOM+screenshot+prompt round-trip) even though the test author had already named the completion condition.

This story describes the two-layer fix that makes SPA waits fast and legacy waits still correct.

## Layer 1 — AI chains a wait with the triggering action

### What changed

Rule 2 ("return exactly ONE action per response") now carves out an exception: the AI MAY return a single `wait` action in the same response as the triggering action (click/type/select/navigate/keypress) when the step instruction names a completion condition. A new rule 22 gives canonical pairings.

```json
// Step: "Click Login and wait until the OTP page loads"
{
  "actions": [
    { "action": "click", "selector": "#login-btn", "description": "Click Login" },
    { "action": "wait", "waitType": "url", "condition": "**/otp", "description": "Wait for OTP page" }
  ],
  "reasoning": "...",
  "needs_reeval": false
}
```

Playwright blocks server-side through the entire redirect chain. Zero AI polling. SPA-agnostic.

### Canonical pairings

| Step language | waitType | Condition |
|---|---|---|
| "…until the OTP page" / "…until /dashboard" | `url` | URL glob (`**/otp`) |
| "…for the success toast" / "…the 'Saved' banner" | `selector` or `text` | CSS selector or visible text |
| "…until the table loads" / "…until results appear" | `count` | row selector + `expected: "1"` |
| "…the loading indicator disappears" | `hidden` | spinner selector |
| "…until the Submit button is enabled" | `attribute` | target selector + `!disabled` |
| "…for the page to navigate" (unspecified destination) | `navigation` | — |

### When NOT to chain

When the instruction doesn't name a completion condition (e.g. just "click Login"), the AI returns only the triggering action. Speculative waits aren't helpful — they'd time out or paper over bugs.

## Layer 2 — SPA-aware post-action settle

### What changed

A new two-function pair in `src/browser/page-state.ts`:

- `capturePageSignal(page)` — cheap URL + DOM fingerprint (body HTML length : text length : element count). Stable enough for equality comparison, coarse enough that cosmetic animations and analytics pings don't flap it.
- `waitForPostActionSettle(page, { preSignal })` — pre/post diff with early exit. Polls at 150ms:
  - **Settled after change**: signal differs from `preSignal` and has been stable for 600ms → done.
  - **No-op**: signal never changed within 1.2s → action didn't affect the page, return.
  - **Hard cap**: 3.5s.

The step-executor captures a `preSignal` before each mutating action and calls the settle after. Observational/control-flow actions (`read`, `count`, `find`, `assert`, `switchPage`, `prompt`, `noop`, etc.) skip the settle entirely — it's pure overhead for them.

### Why this beats `networkidle`

- **SPAs**: DOM fingerprint changes when the route swaps (even if websockets keep the network busy). No more 6s waits for `networkidle` that never comes.
- **Legacy apps**: URL changes on real navigation — fingerprint catches that too.
- **Optimistic UI**: 600ms settle window is long enough to outlast most skeleton → real-content swaps but short enough that fast SPAs still finish quickly.
- **No-op actions**: if nothing changed in 1.2s, nothing is going to — don't burn the full timeout.

### Supporting fixes

- `waitForPageStability` default `networkIdle` flipped to `false`. Previously it defaulted to `true`; the branched-step poller inherited that and also hung on `networkidle` on SPAs.
- `wait` action type `navigation` now outlasts redirect chains. Previously it resolved on the first URL change (SSO/OAuth flows: `/auth/start` → `/sso/provider` → `/sso/callback` → real destination would return on hop 1, producing a snapshot of an intermediate page). Now it waits for the URL to be stable for ~400ms after the first change before returning.

## Mutating vs. non-mutating actions

The settle only runs for actions that can affect the page:

| Mutating (settle runs) | Non-mutating (settle skipped) |
|---|---|
| `click`, `type`, `select`, `navigate` | `read`, `count`, `find`, `expand` |
| `upload`, `hover`, `keyboard`, `keypress` | `assert`, `prompt`, `noop` |
| `dismiss`, `scroll`, `wait` | `switchPage`, `closePage`, `extract_csrf`, `extract_value`, `api_call` |

`wait` is treated as mutating because it may be followed by another action in the chain — the settle gives the page a moment to reflect the condition it waited on (e.g. a toast that appears right after the URL matches).

## Interaction between the two layers

Best case: Layer 1 applies. AI emits `click` + `wait type=url` in one turn. Playwright blocks server-side through redirects. The settle afterwards is a no-op (signal already stable by the time Playwright returned). One AI round-trip total.

Fallback case: Layer 1 doesn't apply (instruction didn't name a condition). AI emits just a `click`. The settle runs: typical SPA reacts within ~800ms, fingerprint changes, 600ms quiet window passes, total settle ~1.4s. Next turn's snapshot captures the post-navigation state. Previous behaviour: up to ~7s of `networkidle` + quiesce overhead.

No-op case: AI emits an action that didn't change anything (wrong selector, disabled button). Settle exits at 1.2s of no-change. Framework moves on instead of waiting out the full timeout.

## Files touched

- `src/browser/page-state.ts` — new `capturePageSignal`, `waitForPostActionSettle`; `waitForPageStability` default flipped.
- `src/browser/actions.ts` — `wait type=navigation` now resolves on final URL of redirect chain.
- `src/runner/step-executor.ts` — pre/post settle integration around `executeAction`, `MUTATING_ACTIONS` set.
- `src/ai/prompts.ts` — rule 2 exception + new rule 22 with canonical pairings.

## Tuning knobs

`waitForPostActionSettle` exposes:

- `timeoutMs` (default 3500) — hard cap.
- `noChangeTimeoutMs` (default 1200) — how long "nothing happening" counts as no-op.
- `settleMs` (default 600) — quiet window required after a change.
- `pollMs` (default 150) — signal capture cadence.

All are conservative defaults chosen to handle skeleton→content swaps on slow SPAs without being sluggish on fast ones. If a specific app needs tuning, the options flow through from the call site.

## What this doesn't solve

- **Infinite spinners** (DOM keeps mutating, network idle, forever): the existing stall detector is the right place for this. Not expanded in this story.
- **Interstitials** (Cloudflare, hCaptcha): pattern-detection not added; the step timeout still absorbs them.
- **AI prompting the test author toward destination-explicit instructions**: the docs/templates haven't been updated to model "click X and wait for Y" over "click X" + "wait a bit". Worth a follow-up.
- **Optimistic UI rollbacks**: if the server rejects and the UI reverts after 600ms+, the settle may return mid-rollback. The honest fix is for the test to name the stable post-rollback condition; the framework can't guess it.
