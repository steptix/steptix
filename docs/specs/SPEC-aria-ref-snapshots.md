# SPEC: Accessibility-ref snapshots, deterministic selector synthesis, and diff-polled waits

**Status:** Proposed — for review before build  
**Opened:** 2026-11-23  
**Audience:** implementation agent working in this repository  
**Depends on:** `playwright` `^1.59.1`, `src/browser/actions.ts` (`ActionTargeting`), `src/browser/page-state.ts` (`armActionWatcher`), `docs/specs/SPEC-codebehind-robustness.md`, `docs/specs/SPEC-structured-table-reads.md`, `docs/specs/SPEC-verify-checks.md`, and `docs/specs/SPEC-scoreboard.md`

---

## 1. Summary

Today, Steptix sends a sanitized HTML DOM snapshot (up to 100,000 characters) on every AI turn and asks the model to do two jobs at once:

1. **Decide intent:** identify which element on the page satisfies the step.
2. **Engineer a selector:** write a valid CSS or Playwright `role=` selector from a lossy HTML projection.

Observed runs show that selector engineering by the runtime model is the single largest source of avoidable first-try failures, wasted retries, and input token spend:

- **Selector misses on real markup (observed, `issues/062`):** across 17 runs of `recording.md` on 2026-09-28, 19 of 38 model-written selectors failed on the first try (`:text-is` missing wrapped `<span>` labels, `[role="button"][name="..."]` matching HTML `name` instead of accessible name), each costing a 10-second timeout plus a retry. Even after rewriting Rule 3, `src/browser/actions.ts` required ~150 lines of `resolveRoleName` fallback (`SPEC-web-survey-fixes.md` §2.34, observed on test 62) because HTML snapshots cannot show accessible names computed from CSS `::before` glyphs or `aria-labelledby` chains.
- **Token and latency cost (observed, `SPEC-scoreboard.md` §16.1 & `survey/web/results/section-c-runs.md` Finding 7):** Section C runs consumed 0.2M–1.8M input tokens per file, dominated by resending HTML snapshots every turn; on `www.super.test`, Playwright's accessibility snapshot measured roughly a quarter of the size of Steptix's sanitized HTML snapshot.
- **Post-action and long-wait overhead (observed, `SPEC-codebehind-robustness.md` §3.3):** `waitForPostActionSettle` spends ~1.3s waiting on static actions that started no network work, yet returns early while a 2s API request is still in flight; meanwhile, waiting up to 90s for an unrendered element (say, an OTP field) either guesses a selector blind before clicking or hits `STALL_LIMIT = 2` / `maxTurns` when polling with the model.

This specification replaces runtime AI selector authoring with **accessibility-snapshot `ref` targeting**, **fast local diff-polling for waits**, and **deterministic Playwright locator synthesis** designed first and foremost so **`Run & Compile` produces reliable, strict-mode-safe `.steps.ts` code**.

### Core invariant

1. **At AI runtime**, the model identifies elements by snapshot reference (`ref: "e15"`, `f1e3`, `s1`) rather than writing CSS selectors.
2. **At execution time**, deterministic framework and Playwright code (`locator.normalize()`, `resolvedSelectorInPage`, and sibling-path derivation) resolves every `ref` against the live DOM into verified, permanent selectors recorded on `ActionTargeting`.
3. **At compile time**, `.steps.ts` never contains ephemeral `ref`s—every compiled entry uses verified Playwright locators (`getByRole`, `getByLabel`, `getByTestId`, scoped CSS, or `step.read` / `step.count`), with native Playwright `waitFor` waits instead of polling loops.

---

## 2. Goals and Non-Goals

### Goals

1. **Eliminate runtime selector syntax errors:** the step AI selects elements from `ariaSnapshot({ mode: 'ai' })` references (`eN`, `f<seq>eN`, and framework-supplemented `sN`).
2. **Cut per-turn input tokens and latency:** send compact accessibility YAML by default, reserving sanitized HTML only for targeted on-demand subtrees (`expand`), check-code generation (`assert`), and compile-time ancestor context.
3. **Fast, cheap waiting and polling:**
   - Static actions that trigger no network and no DOM mutation settle in $\le 250\text{ ms}$ via `armActionWatcher`.
   - Long waits for unrendered UI (say, *"Click Continue and wait up to 90 seconds for the OTP field to appear"*) poll `ariaSnapshot` locally at **zero token cost** while the page is unchanged, waking the AI only on real UI changes with backoff against ticking timers.
4. **First-class `Run & Compile` reliability:** every `ref` action, plural read, and diff-polled wait records live-verified Playwright locators and structural metadata so `.steps.ts` replays deterministically in strict mode across static, looped, and data-driven (`{{param}}`) tests.
5. **Measurable rollout:** ship behind `browser.snapshotMode: 'aria' | 'dom'` and wire `form: 'ref'` into `steptix stats` (`SPEC-scoreboard.md` §5.3, §16.1) so `firstTry` %, `tokensIn`, step wall clock, and compiled replay pass rates can be compared directly on the same suite.

### Non-goals

- **Do not use Playwright MCP (`@playwright/mcp`):** call Playwright `1.59.1`'s in-process APIs directly (`locator.ariaSnapshot`, `aria-ref=`, `locator.normalize()`). Note that `page.getByRef()` was added in Playwright `1.64` and must not be called while `package.json` pins `1.59.1`.
- **Do not drop `selector` pass-through:** test authors may still name explicit selectors or frame IDs in `## Context` (`SPEC-web-survey-fixes.md` §2.46), and recorded `.steps.ts` helpers (`step.read`, `step.count`) execute CSS/Playwright selectors on replay.
- **Do not add site-specific heuristics or visibility rules (`CLAUDE.md`):** supplementary refs use browser-standard questions (`input[type="file"]`, `checkVisibility()`, `data-steptix-row`) and prompt examples use invented names only.
- **Do not change `[use computer]` (`SPEC-use-computer.md`) or `[use ai]` (`stories/use-ai-step.md`).**

---

## 3. Page Snapshot Architecture (`src/browser/aria-snapshot.ts`)

### 3.1 Primary capture: `html`-rooted `ariaSnapshot({ mode: 'ai' })`

`page.ariaSnapshot()` only walks `document.body`, which misses full-screen overlays and dialogs appended as children of `<html>` beside `<body>` (`SPEC-web-survey-fixes.md` §2.48). Capture instead from `html`:

```ts
const rawYaml = await page.locator('html').ariaSnapshot({
  mode: 'ai',
  timeout: PAGE_EVALUATE_TIMEOUT_MS,
});
```

In Playwright `1.59.1`, `mode: 'ai'`:
- Emits role, accessible name (including CSS `::before`/`::after` content, SVG `<title>`, and `aria-labelledby`), checked/disabled/expanded/selected/level states, link `url`, input `placeholder`, and live input values.
- Traverses open Shadow DOM (`element.shadowRoot`) automatically.
- Traverses visible `<iframe>`s and prefixes their refs with `f<frameSeq>` (for example, `f1e4`).

### 3.2 Mandatory secret & password-field masking

**Security finding (traced in Playwright `packages/injected/src/ariaSnapshot.ts` `toAriaNode`):** Playwright's `ariaSnapshot` copies `element.value` into `children` for every `<input>` except `checkbox`, `radio`, and `file`—which **includes `<input type="password">`**! Unlike `src/browser/scripts/secret-field.js` in `capture-dom.js`, raw `ariaSnapshot` would expose a browser-autofilled or password-manager-filled password that is not in `secretsFor(opts)`.

Before returning any aria snapshot from `captureAriaPageSnapshot`:

1. Run a lightweight in-page scan (same rule as `src/browser/scripts/secret-field.js`: `input[type="password"]`, `autocomplete="current-password" | "new-password" | "one-time-code"` when masked, or `-webkit-text-security` != `'none'`) across reachable frames to collect any non-empty live values in secret-styled fields.
2. Redact both `secretsFor(opts)` and those secret-field values (`redact(snapshotText, [...runSecrets, ...secretFieldValues])`), replacing them with `***` / `••••` before the snapshot reaches the AI, logs, recordings, or HTML reports.

### 3.3 Closing Playwright `ariaSnapshot` blind spots: Supplementary Refs (`[ref=sN]`)

In Playwright's `computeAriaRef`, `[ref=eN]` is assigned only when `box.visible && receivesPointerEvents`. That leaves four deterministic blind spots in real tests, closed by a single fast browser pass (`collectSupplementarySnapshotMeta`) run alongside `ariaSnapshot`:

1. **Hidden `<input type="file">` (`[ref=sN]`):**
   - Styled uploaders hide `<input type="file">` with `display: none` or `opacity: 0`, so `ariaSnapshot` omits them completely.
   - Scan reachable frames for `input[type="file"]` that did not receive a Playwright `eN` ref. Stamp `data-steptix-ref="sN"` (cleared on the next snapshot) and append a `## File Inputs` section:
     ```yaml
     # File Inputs (hidden native upload targets)
     - file-input "Upload document" [accept=".pdf,.png"] [multiple] [ref=s1]
     ```
     (Label derived from `<label for>`, `aria-label`, `name`, or `id`.)

2. **Rendered controls temporarily failing `receivesPointerEvents` (`[ref=sN]`):**
   - When a sticky bar or overlapping banner covers an input's center (`SPEC-web-survey-fixes.md` §2.20), `checkVisibility()` is `true`—a person sees the control—but `receivesPointerEvents` is `false`, so Playwright omits `[ref=eN]`.
   - Any `<input>`, `<textarea>`, `<select>`, `<button>`, or `[role="button"|"link"|"checkbox"|"radio"|"combobox"|"tab"|"menuitem"|"option"]` where `el.checkVisibility()` is `true` (and for hidden checkbox/radio inputs, whose `<label>` or visible stand-in box is visible per `SPEC-web-survey-fixes.md` §2.10) that lacks an `_ariaRef` gets a supplementary `sN` ref so `executeType` / `executeClick` can scroll or stand-in click it as today.

3. **`data-steptix-row="N"` annotations from `readTable` (`SPEC-structured-table-reads.md` §7.4):**
   - After `readTable` stamps `data-steptix-row="1..K"` on data rows, raw `ariaSnapshot` does not emit `data-*` attributes.
   - When stamped rows exist on the page, record each stamped row's `sN` (or existing `eN`) ref and emit a compact map (`# Stamped Table Rows: table "Orders" -> row 1 [ref=e21], row 2 [ref=e28], ...`) so *"Click Review in row 7 of the Orders table"* resolves deterministically without row-counting errors.

4. **Existing non-DOM footers preserved verbatim:**
   - Scroll geometry (`Scroll position: <top>–<bottom> of <total>px`), `Open Pages`, browser dialogs (`describeDialogs`), and closed WAI-ARIA live-region notifications (`noticeNote`, `SPEC-web-survey-fixes.md` §2.33 & §2.50) attach to the message exactly as in `dom-cleaner.ts` today.

### 3.4 Per-page `SnapshotRefRegistry` (Iframe & Ref Resolution in Playwright `1.59.1`)

In Playwright `1.59.1`, `aria-ref=e15` resolves against `InjectedScript._lastAriaSnapshotForQuery` in the **specific frame** that owns that ref (`e15` in the main frame, `f1e4` in frame 1). Calling `page.locator('aria-ref=f1e4')` on the top page alone only queries the main frame.

`captureAriaPageSnapshot` maintains a `SnapshotRefRegistry` on the session's active `Page` for the latest snapshot:

- **`generationId`:** monotonic counter incremented on each snapshot capture and invalidated on main-frame navigation.
- **`framesByPrefix`:** maps `""` $\to$ `page.mainFrame()`, and `"f1"`, `"f2"`, … $\to$ the exact `Frame` handle and its verified **CSS `frameSelector` chain** (`#outer-frame >> #inner-frame`, computed via `frame.frameElement()` + `buildSelector` at capture time).
- **`supplementaryRefs`:** maps `"s1"`, `"s2"`, … $\to$ `{ frameSelector?: string, refAttr: "s1" }` resolved via `root.locator('[data-steptix-ref="s1"]')`.

`resolveRefTarget(page, ref)` returns:

```ts
export interface ResolvedRef {
  /** Locator pointing to the exact element in its owning frame. */
  locator: Locator;
  /** Owning Page or FrameLocator, for relative scoping and measurement. */
  root: Page | FrameLocator;
  /** Deterministic frame chain (e.g. "#demo-frame"), undefined for main frame.
   *  Recorded onto RecordedAction.frame so Run & Compile emits frameLocator(). */
  frameSelector?: string;
}
```

If a `ref` is missing from the current registry or its element is disconnected (`count() === 0`), `resolveRefTarget` fails immediately (**no 10-second timeout!**) with a fast, actionable message:
`Ref "${ref}" is no longer in the current page snapshot (the page updated or navigated). Inspect the fresh snapshot on the next turn and pick the current ref.`

---

## 4. When `ariaSnapshot` vs. Sanitized DOM Is Sent

The framework **never guesses** from step prose which format to send. The format is determined strictly by the call site in `src/runner/step-executor.ts`:

| Call site | What is sent / captured | Why |
|---|---|---|
| **Step planner (`buildStepMessage`, turn 1..N)** | `ariaSnapshot` + `ref`s (`## Page Snapshot`) | Default for 100% of live steps (`click`, `type`, `select`, `upload`, `drag`, `read`, `count`, `readTable`, `wait`, `assert` stage 1). |
| **Condition judge (`If` / `While`, line 5537) & Branched step poll (line 5744)** | `ariaSnapshot` + `ref`s | Evaluates visible page state at ~25% of the token cost. |
| **`expand` action (`{ "action": "expand", "ref": "e8" }`, line 4096)** | `expandDomSubtree` sanitized HTML of **only `e8`** (with inner elements also stamped with `sN` refs) | On-demand zoom when `ariaSnapshot` flattens inline `<span>`s (`"Everyday •••• 4417 $1,234.56"`) or unlabelled `<div>` controls. |
| **`readTable` non-table fallback (`SPEC-structured-table-reads.md` §7.10, line 2434)** | `expandDomSubtree` sanitized HTML of **only that container `ref`** | One-time structure question (`StructureMemo`) when a repeated card/list is neither `<table>` nor `role="grid"`. |
| **`assert` Stage 2 check-code generator (`captureCheckCodeDom`, line 4900)** | Sanitized HTML DOM (`CHECK_CODE_DOM`) | Preserves `SPEC-verify-checks.md` verbatim: stage 2 writes a `document.querySelector(...)` snippet executed in `page.evaluate`. |
| **`Run & Compile` step context (`captureStepContext`)** | `ariaSnapshot` before/after + **targeted ancestor HTML snippet** (`targeting.elementContextHtml`, §7.2) around each acted `ref` | Gives `generate.ts` exact HTML attributes/ancestors around touched elements for `{{param}}` locators without capturing two 100k-char full-page HTML dumps per step. |
| **`get_page_content` / `peek_tab` (`src/server/page-capture.ts`)** | Existing `'text' \| 'dom'` unchanged; add optional `'aria'` | Preserves backwards compatibility for external MCP / Sessions API callers. |

---

## 5. Action Schema & Deterministic Selector Synthesis

### 5.1 Additions to `AIAction` (`src/ai/types.ts` & `src/ai/action-parser.ts`)

Keep the existing response wrapper (`{ "actions": [...], "reasoning": string, "needs_reeval": boolean }`) and all existing `VALID_ACTION_TYPES`. Add explicit ref fields validated against `/^(?:f\d+)?e\d+$|^s\d+$/`:

```ts
export interface AIAction {
  // ... existing fields preserved ...

  /** Snapshot ref of the target element (e.g. "e15", "f1e4", "s1").
   *  Preferred over `selector` for all singular element actions, `readTable`, and `expand`. */
  ref?: string;

  /** `drag` only: snapshot ref of the drop target element (replaces `target` CSS). */
  targetRef?: string;

  /** Plural `read` and `count`: snapshot ref of the enclosing list/table/container,
   *  paired with 1–2 `exampleRefs` pointing to sample items to read/count. */
  containerRef?: string;
  exampleRefs?: string[];

  /** `noop` / completion after a `waitType: "change"` poll: ref of the element whose
   *  appearance satisfied the step's wait condition, so Run & Compile emits a
   *  deterministic `locator.waitFor({ state: 'visible', timeout })` (§6.2). */
  foundRef?: string;
}
```

`selector` and `target` remain valid optional fallbacks (for `## Context` author hints and legacy `snapshotMode: 'dom'`). If the AI puts an aria ref string into `selector` (say, `"e15"` or `"aria-ref=e15"`), `action-parser.ts` normalizes it into `action.ref = "e15"` using an **anchored** regex (`/^(?:aria-ref=)?((?:f\d+)?e\d+|s\d+)$/`) so real IDs like `z2l9e43l3` are never misclassified.

### 5.2 Plural `read` and `count` without AI-written CSS (`deriveRepeatingSelector`)

To avoid asking the AI to write CSS like `#account-list [data-testid="account-row"] > span > span:first-child`:

1. **When $\ge 2$ items are visible with refs (`containerRef: "e8"`, `exampleRefs: ["e12", "e15"]`):**
   - If the target elements are inline `<span>`s flattened by `ariaSnapshot`, the AI calls `{ "action": "expand", "ref": "e8", "needs_reeval": true }` on Turn 1; `expandDomSubtree` stamps `sN` refs onto the inner elements inside `e8`, and on Turn 2 the AI passes `containerRef: "e8"` + `exampleRefs: ["s3", "s6"]`.
   - Browser helper `deriveRepeatingSelectorInPage(containerEl, exampleEls)` computes the deterministic selector:
     1. Verify every `exampleEl` is a descendant of `containerEl`.
     2. Find the repeating item ancestor under `containerEl` (the lowest common pattern depth where `exampleEls[0]` and `exampleEls[1]` sit in distinct sibling branches).
     3. Build a relative selector from the repeating item to the target leaf: prefer `[data-testid]`, semantic `[role]`, non-generated class names (matching `kinds` rule: no digits), else tag + `:nth-child(k)` / `:first-child` when siblings share the same tag and lacks non-generated classes.
     4. Scope under `containerEl`'s verified `buildSelector(containerEl)`.
     5. Verify in-page that the derived selector matches both `exampleEls` and has uniform `kinds` (`SPEC-codebehind-robustness.md` §6.6); execute `executeReadMultiple` / `executeCount` with that verified selector and store it as `targeting.resolvedSelector`.

2. **Edge case — `1`-item list (`exampleRefs: ["e12"]`):**
   - Walk up from `e12` to the direct child of `containerEl` (skipping `<tbody>` / `<thead>` / `<tfoot>` wrappers inside `<table>`) as the repeating item root, build the same relative leaf path, and verify `matchCount === 1` inside `containerEl`.

3. **Edge case — `0`-item (empty) list (`containerRef: "e8"`, `exampleRefs: []`):**
   - At AI runtime, `read[multiple]` stores `"[]"` and `count` stores `"0"` immediately—passing cleanly on empty states (`templates/init/tests/table-documents-empty.md`).
   - For `Run & Compile`, `targeting.resolvedSelector` is intentionally absent, so `SPEC-codebehind-robustness.md` §6.6's existing `unprovenListRead` rule applies automatically: an empty list proves no item selector, so the step stays uncompiled (never `ai: true`) until a compile run sees $\ge 1$ item, or uses a sibling data row that had items (`evidenceRank`).

4. **List-read review (`src/runner/list-read-review.ts`) in `'aria'` mode:**
   - When a plural `read` or `count` returns empty or matches mixed `kinds`, `listReadConcern` formats `containerRef` / `exampleRefs` (rather than `action.selector`) and instructs the `reviewOnly` turn to either keep the result as-is or `expand` `containerRef` and pick refined `exampleRefs`—never nudging the model to guess raw CSS against an `ariaSnapshot`.

---

## 6. Fast & Cheap Waiting and Polling

### 6.1 Fast network-aware post-action settle on the AI path

Replace `waitForPostActionSettle`'s blind 1.2s idle wait in `step-executor.ts` with `armActionWatcher` (`src/browser/page-state.ts`, `SPEC-codebehind-robustness.md` §6.4), armed before each mutating browser action:

- **Static action (no first-party `document`/`fetch`/`xhr` started, DOM unchanged):** exits via `quickExitMs: 250` (~1s faster per field fill or local toggle than today's ~1.3s settle).
- **Network-triggering action (say, a 1.8s login POST):** waits for the tracked first-party request and any chained navigation + `quietMs: 600` (bounded by `min(5_000, execution.timeout)` on routine AI runs, `min(10_000, execution.timeout)` on compile runs), preventing premature Turn-2 snapshots of the old page.
- **Immediate action chains (`SPEC-web-survey-fixes.md` §2.17):** still skip post-action settle between `[click Start, wait ..., click Stop]`.

### 6.2 Diff-polled `wait` (`waitType: "change"`) — Zero-token local waiting

Consider: *"Click Continue and wait up to 90 seconds for the OTP field to appear."*

Before clicking `Continue`, the OTP field is not in the DOM, so neither its `ref` nor its selector is known.

#### Runtime execution flow

1. **Turn 1:** AI sees `button "Continue" [ref=e6]` and emits:
   ```json
   {
     "actions": [
       { "action": "click", "ref": "e6", "description": "Click Continue" },
       { "action": "wait", "waitType": "change", "timeout": 90000, "description": "Wait up to 90s for the OTP field to appear" }
     ],
     "needs_reeval": true
   }
   ```
2. **Local diff-poller (`waitForSnapshotChange` in `src/browser/aria-snapshot.ts`):**
   - Captures `baseline = normalizeForDiff(lastShownSnapshot)` (strips `[ref=...]`, `[active]`, and collapses digit-only countdown ticks like `"Resend in 59s"` $\to$ `"Resend in #s"` when role/control structure is unchanged).
   - Polls `page.locator('html').ariaSnapshot({ mode: 'ai' })` + `page.url()` locally with **zero LLM calls** while `normalizeForDiff(current) === baseline`:
     - Poll cadence: `200ms` for the first `3s`, `500ms` up to `15s`, `1000ms` thereafter.
     - Progress heartbeat: log `Waiting up to <N>s for page change…` on entry and emit an info heartbeat every `15s` (`Still waiting for page change — <elapsed>s of <budget>s elapsed`) so VS Code and CLI users see the wait is alive rather than hung.
     - Debounce: once a change is detected, wait `150ms` (or `armActionWatcher` quick settle if a navigation just committed) so the AI sees a complete render rather than an empty mid-transition frame.
     - Cancellation: races every sleep and evaluate against `opts.signal` so clicking **Stop** in VS Code or CLI aborts within `<100ms` (`issues/020`).
3. **Multi-stage transitions & anti-clock backoff:**
   - Suppose at `t = 1s` the page renders `"Sending code..."` (no OTP box yet). The snapshot changed, so Turn 2 wakes the AI with the remaining poll budget (`pollRemainingMs: 89000` shown in prompt metadata).
   - The AI sees the step is still waiting and returns `{ "action": "wait", "waitType": "change", "description": "Still sending code, continue waiting for OTP field" }` (`needs_reeval: true`), reusing the step's active `pollDeadline` rather than resetting another 90s.
   - **Backoff against noisy pages:** if the page mutates text repeatedly without adding/removing interactive controls or changing URL, enforce a minimum interval between AI re-checks of `1s -> 2s -> 4s -> 5s` (capped at `5s`), **immediately bypassed** the instant a new interactive `[ref=...]` control appears or the URL changes. Over 90s, even a noisy page makes at most ~15 compact calls, and a normal spinner makes **2 total AI calls** (Turn 1 click + Turn 2 when OTP appears).
   - **Stall & turn-cap coordination (`step-executor.ts`):**
     - While `pollDeadline` is active, `waitForSnapshotChange` blocks locally on an unchanged page instead of returning an unchanged turn to the loop—so `STALL_LIMIT = 2` is never falsely tripped. If `pollDeadline` expires with no further change, throw `StepFailureError` immediately: `Timed out after 90s waiting for page change ("Wait up to 90s for the OTP field to appear").`
     - Intermediate `waitType: "change"` continuation turns inside an active `pollDeadline` count against `MAX_POLL_AI_CHECKS = 15` rather than consuming `execution.maxTurns` needed for post-wait actions in the same step.
4. **Completion & `foundRef`:**
   - When `- textbox "One-time code" [ref=e12]` appears, the AI sees it and finishes:
     - If the step only asked to wait: `{ "actions": [{ "action": "noop", "foundRef": "e12", "description": "OTP field is visible" }], "needs_reeval": false }`.
     - If the step asked to *"wait up to 90s for the OTP field and enter {{otp}}"*: `{ "actions": [{ "action": "type", "ref": "e12", "value": "{{otp}}", "description": "Enter OTP" }], "needs_reeval": false }`.

#### Deterministic in-turn waits (0 extra AI turns)

Existing non-CSS waits remain available for single-turn chains:
- `waitType: "url" | "text" | "duration" | "navigation" | "load" | "stable"`.
- `waitType: "hidden"` and `waitType: "attribute"` accept `"ref"` for elements **already present** in the snapshot (for example, `[click ref=e10 (Start), wait attribute ref=e11 "aria-valuenow>=75", click ref=e12 (Stop)]`). Before running action 1 of a chain, `step-executor.ts` pre-resolves every `ref` in the chain to a normalized `Locator` (`locator.normalize()`), so even if action 1 triggers a DOM re-render that invalidates snapshot `eN` pointers, actions 2 and 3 still resolve against the live page!

---

## 7. Compiling `ref` Runs to Reliable `.steps.ts` Code-Behind

Everything captured at runtime is designed so compiled `.steps.ts` tests are **more** reliable than today's selector-authored runs.

### 7.1 Dual locator measurement on every `ref` action (`src/browser/actions.ts`)

When `executeAction` runs with `ref` (always when `captureStepContext` / `measure` is enabled, and for pre-resolved chains):

1. Resolve `ResolvedRef` (`locator`, `root`, `frameSelector`). If `frameSelector` is present, write `recordedAction.frame = frameSelector` so `generate.ts` knows the iframe path without guessing.
2. Compute **two** verified permanent selectors against the live DOM within `MEASUREMENT_TIMEOUT_MS` (2s):
   - **Playwright semantic locator (`normalizedLocator`):** call `const norm = await target.normalize()`, recording `norm.toString()` (for example, `getByRole('button', { name: 'Sign in' })`, `getByLabel('Email')`, `getByTestId('submit')`). Classify `normalizedBy: 'testid' | 'role' | 'label' | 'text' | 'chained' | 'positional'` (`'positional'` whenever `.nth(` or `nth=` appears).
   - **Verified CSS backup (`resolvedSelector` + `resolvedBy`):** keep existing `resolvedSelectorInPage` (`#id`, `[data-testid="..."]`, scoped CSS, or positional chain) and `matchCount` / `visibleMatchCount` measured against the normalized locator (`matchCount` is `1` whenever `locator.normalize()` succeeded without `.nth()`, because Playwright's selector generator verifies strict uniqueness across the entire frame, hidden elements included!).
   - **Stand-in & upload routes preserved:** if clicking a hidden checkbox clicked its `<label>` or visible box (`standIn: 'label' | 'box'`), normalize the **clicked stand-in element** so `.steps.ts` clicks what works in strict mode; for `upload`, record `upload: { via: 'input' | 'chooser' }` as today.

```ts
export interface ActionTargeting {
  matchCount?: number;
  visibleMatchCount?: number;
  resolvedSelector?: string;
  resolvedBy?: ResolvedBy;
  /** Playwright's idiomatic locator expression from `locator.normalize().toString()`,
   *  e.g. `getByRole('button', { name: 'Sign in' })`. Verified strict-unique in its frame. */
  normalizedLocator?: string;
  normalizedBy?: 'testid' | 'role' | 'label' | 'text' | 'chained' | 'positional';
  /** Compact sanitized HTML of the target element + up to 3 ancestors (to nearest
   *  row/listitem/section), captured during compile runs so parameterized steps
   *  (`{{order_id}}`) see how row data relates to the target. Redacted before storage. */
  elementContextHtml?: string;
  kinds?: string[];
  roleNameFallback?: string;
  standIn?: 'label' | 'box';
}
```

### 7.2 Compiling the four step shapes reliably (`src/codebehind/generate.ts`)

1. **Read-only and count-only steps (`fromRecording: true`, 0 LLM calls):**
   - Preserves `SPEC-codebehind-robustness.md` §6.6 completely.
   - Single `read` (`ref: "e9"`) and plural `read` / `count` (`containerRef` + `exampleRefs`) populate `targeting.resolvedSelector` and `targeting.kinds` at runtime.
   - `generate.ts` writes `await step.read({ selector: targeting.resolvedSelector, multiple, as, kinds })` with **zero model calls** (provided no parameter value is inlined in `resolvedSelector` and `resolvedBy !== 'positional'` on a named/parameterized step).

2. **Diff-polled waits (`waitType: "change"`, `timeout: 90000`):**
   - In `actionsOf(result)` (`src/codebehind/recording.ts`), collapse a multi-turn `waitType: "change"` sequence with its resolving action (`noop` carrying `foundRef`, or the immediately following action on `e12` in the same step):
     - Copy the resolving element's `normalizedLocator` / `resolvedSelector` onto the recorded `wait` action (`resolvedWaitTarget`), preserving the original `timeout` (`90000`).
   - `generate.ts` compiles the wait into native Playwright auto-waiting with **zero polling loops**:
     ```ts
     await page.getByRole('button', { name: 'Continue' }).click();
     await page.getByLabel('One-time code').waitFor({ state: 'visible', timeout: 90_000 });
     ```
   - **Missing-`foundRef` backstop:** if a step containing `waitType: "change"` ends on `noop` without `foundRef`, diff the final snapshot against the pre-wait baseline snapshot; if exactly one new interactive `[ref=...]` control appeared, normalize and attach it automatically, and otherwise pass the diffed text/roles to `generate.ts` with the original `timeout`.
   - If the wait resolved on plain text (`foundRef` absent, step waited for visible text), emit `await page.getByText('...').first().waitFor({ state: 'visible', timeout: 90_000 })`. Never fall back to `step.settle()` alone for a wait whose recorded `timeout` exceeded `10_000`ms, because `step.settle()` caps at `10s`.

3. **Static interaction steps (`click`, `type`, `select`, `hover` with no target placeholder):**
   - The compile prompt receives `targeting.normalizedLocator` (`page.getByRole('button', { name: 'Sign in' })`) and `targeting.resolvedSelector` (`#sign-in-btn`).
   - Because `locator.normalize()` already verified `matchCount === 1` across hidden mobile duplicates (`stories/codebehind-selector-ambiguity.md`), strict-mode ambiguity failures on replay are prevented by construction.

4. **Parameterized / data-driven interaction steps (`"Click Approve in the row for {{order_id}}"`):**
   - On row 1 (`order_id = "ORD-101"`), `normalizedLocator` might be `getByRole('row', { name: 'ORD-101 Pending Approve' }).getByRole('button', { name: 'Approve' })` or `getByRole('button', { name: 'Approve' }).nth(0)` (`normalizedBy: 'positional'`).
   - Because `targeting.elementContextHtml` shows the row's markup (`<tr><td>ORD-101</td><td>Pending</td><td><button>Approve</button></td></tr>`) alongside `## Parameters` (`{{order_id}} = "ORD-101"`), `generate.ts`'s existing leak guard (`findInlinedParameterValue`) and positional carve-out force the entry to parameterize cleanly:
     ```ts
     const orderId = step.getVar('order_id');
     await page.getByRole('row').filter({ hasText: orderId }).getByRole('button', { name: 'Approve' }).click();
     await step.settle();
     ```

### 7.3 Hard static guards in `generate.ts`, `review.ts`, and `repair.ts`

Add three deterministic checks to `staticEntryComplaint` (enforced across generation, Review revisions, and repair):

1. **`ephemeralRefInCodeComplaint`:** rejects any entry containing `aria-ref=`, `getByRef(`, `data-steptix-ref`, or bare snapshot ref strings (`'e15'`, `'f1e4'`, `'s1'`) passed to `locator()`. An ephemeral ref in `.steps.ts` would fail 100% of replays; if a re-ask still contains one, withhold the entry (`stepsNotCompiled`, leaving the step on AI rather than writing broken code).
2. **`readSelectorComplaint` update (`SPEC-codebehind-robustness.md` §6.2):** when the recorded `read` or `count` used `ref` / `exampleRefs` (so `action.selector` was absent), hold the compiled entry to `action.targeting.resolvedSelector` or `action.targeting.normalizedLocator`.
3. **`waitTimeoutDroppedComplaint`:** when the recorded transcript contains a `wait` with `timeout > 10_000`, reject any generated entry that omits an explicit `timeout` $\ge$ that recorded value (preventing a `90_000`ms wait from silently compiling to a `10_000`ms default or `step.settle()`).

---

## 8. Edge Cases & Safeguards Checklist

| Edge case | How the design handles it |
|---|---|
| **Stale `ref` after DOM update inside a multi-action turn** | Single-action-per-turn remains the rule (Rule 2). In the two legal multi-action chains (`[dialog, click]` and `[trigger, wait, optional action]`), `dialog` does not touch the DOM, and `[trigger, wait, action]` pre-resolves all `ref`s via `locator.normalize()` *before* executing `trigger` (§6.2). |
| **Iframe & nested-iframe elements (`f1e4`)** | `SnapshotRefRegistry` maps `f<seq>` to the owning `Frame` and records the CSS `frameSelector` (`#outer >> #inner`) onto `RecordedAction.frame`, so both live execution and compiled `page.frameLocator(...)` work across nested frames. |
| **Cross-origin iframes** | Playwright's `ariaSnapshot({ mode: 'ai' })` runs via CDP/Playwright frame injection across cross-origin frames; `SnapshotRefRegistry` resolves `page.frames()` handles without same-origin `contentDocument` restrictions. |
| **Open & closed Shadow DOM** | Open shadow roots are walked natively by `ariaSnapshot` and `locator.normalize()`. Closed shadow roots (`SPEC-web-survey-fixes.md` §2.27) target the host element's `ref` with `action: "type"` (which clicks the host and types on the keyboard) or `action: "keyboard"`. |
| **Hidden `<input type="file">`** | Surfaced in `## File Inputs` with synthetic `[ref=sN]`; `executeUpload` resolves `sN` to the `<input type="file">` (`via: 'input'`) or clicks a named button `ref` (`via: 'chooser'`). |
| **Password & secret fields** | Pre-redacted via `secret-field.js` scan + `secretsFor(opts)` before the snapshot leaves `captureAriaPageSnapshot` (§3.2), including `targeting.normalizedLocator` and `targeting.elementContextHtml` in `actionsOf` (`recording.ts`). |
| **Ticking clock / live counter during a 90s wait** | `normalizeForDiff` ignores pure digit ticks when role structure is unchanged, and AI re-checks back off `1s -> 2s -> 4s -> 5s` unless a new `[ref=...]` control or URL appears (§6.2). |
| **User clicks Stop during a 90s local poll** | `waitForSnapshotChange` aborts immediately on `opts.signal`, marking the step `interrupted: true` without waiting for the poll tick or making another AI call. |
| **Very large pages (10,000+ nodes)** | Enforce `domSnapshotCharLimit` (default 100,000 chars) on `ariaSnapshot` output with an explicit `<!-- snapshot truncated; use find or scroll -->` marker, keeping `find` (`findInDom`, returning matching snippets + `sN` refs) available. |
| **`steptix stats` scoreboard (`SPEC-scoreboard.md`)** | Update `actionSelector` in `src/stats/classify.ts` so an action with `action.ref` (and no `action.selector`) returns `aria-ref=${action.ref}`, classifying under the already-reserved `'ref'` `SelectorForm` (`classify.ts:90`). |
| **HTML Report & failure diagnostics** | When `snapshotMode: 'aria'` is active, `postDom` in `step-executor.ts` captures `captureAriaPageSnapshot` (skipping redundant full-HTML walks after every action) and the report template labels the panel `Page Snapshot` so the report matches what the AI reasoned over. |

---

## 9. Configuration, Fixture App Scope & Phased Implementation Plan

### 9.1 Configuration (`src/config/types.ts`, `src/config/defaults.ts`, `schema/`)

Add `snapshotMode?: 'aria' | 'dom'` to `BrowserConfig`:
- Phase 1–3 default: `'dom'` (opt-in `'aria'` via `steptix.config.json` or `STEPTIX_SNAPSHOT_MODE=aria` for side-by-side scoreboard benchmarking).
- Phase 4: the default is `'aria'`. `'dom'` stays available in `steptix.config.json` and via `STEPTIX_SNAPSHOT_MODE=dom`. The 7-file comparison in §9.5 cut step input tokens by 31.5%. There is no token-reduction bar for the flip (see §9.6).

### 9.2 Fixture App (`fixtures/test-app`) & Live Test Scope

All live tests under `templates/init/tests/` must run against repo-controlled pages in `fixtures/test-app` (SecureBank) with shard-safe client-side state (`CLAUDE.md`). Extend SecureBank before building Phases 1–3 so every edge case has a deterministic local target for both AI runs and `Run & Compile` replays:

1. **`fixtures/test-app/mfa.html` & `mfa-login.html` (`?countdown=1` / `?mfaCountdown=1`):**
   - Preserve existing behaviour by default. When `countdown=1` is set alongside `delay=<ms>`, tick `"Sending verification code... (<N>s remaining)"` once per second until `#mfa-form` (`#mfa-code`) becomes visible—exercising `waitType: "change"` anti-clock normalization/backoff and compiled `waitFor({ state: 'visible', timeout })`.
2. **`fixtures/test-app/aria-edge-cases.html` (`/aria-edge-cases` route in `server.ts`):**
   - **Sibling of `<body>` on `<html>` + CSS `::before` glyph accessible name:** a dismissible notice appended directly to `document.documentElement` (`<html>`) whose button draws a `::before` symbol ahead of `"Acknowledge"`.
   - **Open & closed Shadow DOM:** `<hardware-key-nickname>` (`mode: 'open'` input + save button) and `<token-serial-box>` (`mode: 'closed'` host that focuses an internal input on click and echoes the entered serial).
   - **Supplementary `[ref=sN]` targets & password-autofill redaction:**
     - a styled checkbox whose `<input type="checkbox">` is `1×1px` / `opacity: 0` inside a visible wrapper box;
     - a pre-populated `readonly` `<input type="password">` holding a synthetic vault value not present in `.env`, proving `captureAriaPageSnapshot` masks secret-styled fields;
     - a bottom input initially overlapped at its center by a fixed help bar (`checkVisibility() === true`, `receivesPointerEvents === false` until scrolled).
   - **Pre-resolved ref chain (`role="progressbar"`):** a deterministic progress bar (`?stepMs=120`) with `Start export` and `Stop export` buttons to prove `[click Start, wait attribute ref "aria-valuenow>=75", click Stop]`.
   - **Sortable drag (`ref`, `targetRef`, `position: "below" | "above"`):** reorderable payment-rule items that decide before/after from drop half.
   - **Transient WAI-ARIA live notice (`role="status"`):** a toast that auto-removes after `?toastMs=1500`, proving closed live-region capture (`__steptixNotices`) in `ariaSnapshot` mode.
3. **New live suites (`steptix-vscode/tests/integration/live/`):**
   - `aria-mfa-wait.test.cjs` — runs and compiles `mfa.html?delay=15000&countdown=1`, asserting few AI turns during countdown, `ephemeralRefInCodeComplaint` cleanliness, `timeout >= 30_000` in `.steps.ts`, and green compiled replay.
   - `aria-edge-cases.test.cjs` — runs and compiles `aria-edge-cases.html` + `documents.html` (hidden `<input type="file">`) + `nested-iframes.html` (`f1eN`/`f2eN`), asserting password redaction in recordings/reports and green `</>` compiled replay.

### 9.3 Phases (one PR per phase)

1. **Phase 1 — Snapshot engine, `ref` execution, and scoreboard wiring (`src/browser/aria-snapshot.ts`, `actions.ts`, `types.ts`, `action-parser.ts`, `prompts.ts`, `stats/classify.ts`):**
   - Build `captureAriaPageSnapshot` (`html` root, password/secret masking, supplementary `sN` refs for file inputs / covered controls / `data-steptix-row`, `SnapshotRefRegistry` for `f<seq>eN` iframes).
   - Wire `ref`, `targetRef`, and `expand` by `ref` in `executeAction` and `step-executor.ts` behind `browser.snapshotMode === 'aria'`, with concise ref-based prompt rules (`buildSystemPromptAria`).
   - Wire `actionSelector` $\to$ `'ref'` in `src/stats/classify.ts`.

2. **Phase 2 — Fast post-action settle & diff-polled `wait` (`page-state.ts`, `aria-snapshot.ts`, `step-executor.ts`):**
   - Wire `armActionWatcher` (`quickExitMs: 250`) into AI mutating actions.
   - Implement `waitType: 'change'` (`waitForSnapshotChange`) with injectable `now`/`sleep`, `AbortSignal` support, `normalizeForDiff`, exponential re-check backoff, `STALL_LIMIT` suspension during active `pollDeadline`, and pre-resolved normalized locators for multi-action chains.

3. **Phase 3 — Plural reads by example & `Run & Compile` integration (`actions.ts`, `recording.ts`, `generate.ts`, `review.ts`, `repair.ts`):**
   - Implement `containerRef` + `exampleRefs` (`deriveRepeatingSelectorInPage`) for `read[multiple]` and `count` (handling $\ge 2$, `1`, and `0` items).
   - Add `normalizedLocator`, `normalizedBy`, and `elementContextHtml` to `ActionTargeting`; fold `waitType: 'change'` + `foundRef` into `waitFor({ state: 'visible', timeout })`; add `ephemeralRefInCodeComplaint` across `generate.ts`, `review.ts`, and `repair.ts`.

4. **Phase 4 — Live & Section C benchmark, default flip, and docs (`docs/test-writing-handbook.md`, `CHANGELOG.md`):**
   - Run the live integration suite (`steptix-vscode`: `npm run test:live`) and a benchmark subset of `survey/web/tests/section-c/` under both `snapshotMode: 'dom'` and `snapshotMode: 'aria'`, comparing via `steptix stats`:
     - `firstTry` step rate must be $\ge$ `'dom'` baseline;
     - compiled `.steps.ts` replay pass rate across `compile-codebehind`, `compile-loops`, `compile-tabs`, `compile-browsers`, `flow-control`, and `data-rows` at 100% with zero `ephemeralRefInCodeComplaint` leaks.
     - `tokensIn` is recorded, not gated. A smaller snapshot is the point of the change; how many fewer tokens a given suite uses is not a condition of shipping `'aria'` as the default.
   - Flip `browser.snapshotMode` default to `'aria'`.

### 9.4 Recorded `Before` Baseline (`snapshotMode: 'dom'`)

Measured in this worktree at commit `57945b33` on `2026-11-23` (`22:36:14`–`22:43:35 AEDT`, `openai/gpt-6-luna`, prompt fingerprint `p-255a97`, `--shards=4`):

```powershell
npm run test:live '--' --shards=4 --files=compile-codebehind.test.cjs,compile-loops.test.cjs,flow-control.test.cjs,data-rows.test.cjs,table-read.test.cjs,wait-timeout.test.cjs,typing.test.cjs
```

- **Suite result:** `20/20` tests passed (`0` failures), **`416s` wall clock** (`1,369s` summed file durations).
- **Per-file wall clock:**
  - `compile-codebehind.test.cjs`: `98s` (3 tests)
  - `compile-loops.test.cjs`: `352s` (2 tests)
  - `flow-control.test.cjs`: `206s` (3 tests)
  - `data-rows.test.cjs`: `328s` (6 tests)
  - `table-read.test.cjs`: `162s` (1 test)
  - `wait-timeout.test.cjs`: `156s` (3 tests)
  - `typing.test.cjs`: `67s` (2 tests)
- **Scoreboard aggregate (`live` + `compile` suites in window):**
  - **AI steps:** `160` run · `156` passed first try (`97.5%`; `156/156` positive steps, `4` intentional negative-test failures, `0` retries)
  - **Model calls:** `232` total (`1.45` calls/step)
  - **Tokens (`tokensIn` / uncached / `tokensOut`):** `3,304,394` step input (`20,652`/step; `4,051,498` run-level input) · `320,094` uncached input (`2,001`/step) · `2,984,300` cached · `56,728` step output (`355`/step; `68,534` run-level output)
  - **Step duration (AI vs. compiled replay):** `961.5s` across `160` AI steps (`6.01s`/step mean) vs. `19.85s` across `42` compiled `code` steps (`0.47s`/step mean)
  - **Element-targeting actions by form:** `id` `48/50` (`2` `no-match` on intentional negative wait tests), `role` `34/34`, `testid` `2/2`, `href` `2/2`, `(no selector)` `102/108`

### 9.5 Recorded `After` Benchmark (`snapshotMode: 'aria'`, Phases 1–3)

Measured in this worktree on `2026-11-24` (`02:20:45`–`02:27:27 AEDT`, `openai/gpt-6-luna`, prompt fingerprint `p-a5d830`, `--shards=4`, `STEPTIX_SNAPSHOT_MODE=aria`) on the identical 7-file / 20-test suite:

- **Suite result:** `20/20` tests passed (`0` failures), **`378s` wall clock** (`-38s` / **`-9.1%`** vs. `416s` baseline; `1,368s` summed file durations).
- **Per-file wall clock (`After` vs. `Before`):**
  - `compile-codebehind.test.cjs`: `85s` vs. `98s` (**`-13.3%`**, 3 tests)
  - `compile-loops.test.cjs`: `378s` vs. `352s` (`+7.4%`, 2 tests)
  - `flow-control.test.cjs`: `218s` vs. `206s` (`+5.8%`, 3 tests)
  - `data-rows.test.cjs`: `288s` vs. `328s` (**`-12.2%`**, 6 tests)
  - `table-read.test.cjs`: `177s` vs. `162s` (`+9.3%`, 1 test)
  - `wait-timeout.test.cjs`: `152s` vs. `156s` (**`-2.6%`**, 3 tests)
  - `typing.test.cjs`: `70s` vs. `67s` (`+4.5%`, 2 tests)
- **Scoreboard aggregate (`live` + `compile` suites in window):**
  - **AI steps:** `161` run · **`156/156` positive steps passed first try (`100.0%`, `0` positive retries)** (`5` expected negative/abort steps from `wait-timeout`, `typing`, and `data-rows` Run-This-Row negative assertions)
  - **Model calls:** **`208` total (`1.29` calls/step)** vs. `232` (`1.45` calls/step) — **`-24` calls (`-10.3%`)**
  - **Tokens (`tokensIn` / uncached / `tokensOut`):**
    - **Step input tokens:** **`2,264,623` (`14,066`/step)** vs. `3,304,394` (`20,652`/step) — **`-1,039,771` tokens (`-31.5%` total, `-31.9%`/step)**
    - **Run-level total input tokens (including condition judge & compile):** **`2,846,841`** vs. `4,051,498` — **`-1,204,657` tokens (`-29.7%`)**
    - **Uncached step input tokens:** **`270,569` (`1,681`/step)** vs. `320,094` (`2,001`/step) — **`-49,525` tokens (`-15.5%` total, `-16.0%`/step)** even on compact ~2–4 KB fixture pages
    - **Step output tokens:** **`47,729` (`296`/step)** vs. `56,728` (`355`/step) — **`-8,999` tokens (`-15.9%` total, `-16.6%`/step)**
  - **Step duration (AI vs. compiled replay):** **`918.8s` across `161` AI steps (`5.71s`/step mean, `-5.0%`)** vs. **`19.90s` across `42` compiled `code` steps (`0.47s`/step mean, `42/42` passed, `0` `ephemeralRefInCodeComplaint` leaks)**
  - **Element-targeting actions by form:** **`ref` `86/86` (`100.0%` first-try `ok`)**, `id` `0/2` (`2` `no-match` on intentional `#never-appears-default` negative wait test), `(no selector)` `73/79`

### 9.6 Phase 4 status — default is `'aria'`

`DEFAULT_CONFIG.browser.snapshotMode` is `'aria'`. A project that omits the key, and a server started without `STEPTIX_SNAPSHOT_MODE`, shows the model the accessibility snapshot. Set `browser.snapshotMode` to `'dom'`, or start the server with `STEPTIX_SNAPSHOT_MODE=dom`, to keep the sanitized HTML snapshot.

§9.5 measured 31.5% fewer step input tokens. That figure is a result, not a bar: shipping `'aria'` as the default does not depend on how large the token drop is. The first-try rate matched the `'dom'` baseline (156/156) and compiled replay was 42/42 with no ephemeral ref. Section C was not re-run. `'dom'` remains the escape hatch.

The live fixtures for the edges in §9.2 write `snapshotMode: 'aria'` into the shard's `templates/init/steptix.config.json` for the file, then restore it, so they still run in aria when the server process itself was started with `STEPTIX_SNAPSHOT_MODE=dom`:

- `steptix-vscode/tests/integration/live/aria-mfa-wait.test.cjs` drives `templates/init/tests/aria-mfa-wait.md` (`mfa.html?delay=15000&countdown=1`). It requires the countdown step to pass in at most 4 actions and at least 8s, the compiled wait to carry `timeout` ≥ 30_000, no snapshot ref in the `.steps.ts`, and a proving run that paints `</>` on at least one step.
- `steptix-vscode/tests/integration/live/aria-edge-cases.test.cjs` drives `aria-edge-cases.md`, `aria-hidden-file.md` (the hidden file input on `documents.html`), and `aria-nested-frames.md` (`nested-iframes.html`). The edge-case recording must not contain the fixture vault passphrase. The nested-frame proposal must contain `frameLocator(`.

---

## 10. Verification Rules (`CLAUDE.md` compliance)

- **Cross-platform, untimed unit tests (`tests/`):**
  - Inject `now` and `sleep` into `waitForSnapshotChange` and backoff logic—never sleep in unit tests or assert on wall-clock elapsed time.
  - Use `listenFetchable` from `tests/listen-fetchable.cjs` and platform-native `fs.mkdtemp` scratch dirs.
  - Test cases required: main-frame `eN` and nested-iframe `f1eN` resolution; stale `ref` fast failure (<50ms, no 10s wait); `<input type="password">` autofill masking in `ariaSnapshot`; hidden `<input type="file">` `sN` upload; `deriveRepeatingSelectorInPage` for 3 items, 1 item, and 0 items (`unprovenListRead`); diff-poller 0-call behavior on unchanged page, immediate abort on `AbortSignal`, ticking-clock backoff, and `foundRef` compilation to `waitFor({ state: 'visible', timeout: 90_000 })`; `ephemeralRefInCodeComplaint` rejecting `aria-ref=` in `generate`, `review`, and `repair`.
- **All four unit suites green on Windows, Linux (WSL), and macOS:** root `npm test`, `runner-core/`, `flick-vscode/`, and `steptix-vscode/` (remembering `npm run build:schema` when touching `src/config/`).
