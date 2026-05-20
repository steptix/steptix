# Test Hooks

## Context

Previously, pre-step and post-step behaviour was controlled by a single global
boolean `execution.dismissObstacles`. When true, a hard-coded heuristic
(`src/browser/obstacle-handler.ts`) ran before the first turn of every step on
every test, scanning for cookie banners, dialogs, and modals, and clicking
whatever "Close" / "OK" / "Accept" button it could find on the page.

This mechanism was too coarse and caused real problems:

- **Global-or-nothing.** No way to enable dismissal for one test and not
  another, or for some steps and not others.
- **Page-wide button scans.** Phase 1 of the handler searched the *entire page*
  for dismiss buttons, not just inside the obstacle — so unrelated "Close"
  buttons got clicked.
- **`[role="dialog"]` is too broad.** Date pickers, command palettes, and
  intentional modals the test was meant to interact with were treated as
  obstacles and closed before the AI saw them.
- **Invisible obstacles leaked into the DOM.** The DOM cleaner's visibility
  check missed `aria-hidden="true"`, ancestor `display: none`, zero-size boxes,
  and `inert` — so pre-rendered modals appeared in the snapshot even when not
  on-screen, prompting the AI to dismiss phantom UI.
- **Opaque.** The handler acted before screenshot/DOM capture, so failures
  caused by auto-dismissal were invisible in the trace.
- **Prompt nudges piled on.** The system prompt had three separate pushes
  toward dismissal (rule #6, and two retry-time hints via `diagnosePageState`),
  which combined with the handler to make the AI reach for the `dismiss`
  action aggressively, even on legitimate UI.

The fix: replace the global heuristic with an **authorable hooks mechanism** in
the test markdown file. Test authors express their own pre/post-step logic in
the same natural language they already use for steps. Skills are composable.
The hard-coded handler is deleted.

## Goals

1. Let test authors define setup/teardown that runs once per test.
2. Let test authors define pre/post-step logic that runs around each step.
3. Let individual steps opt out of hooks when hooks would interfere with what
   the step is trying to do.
4. Let projects define default hooks that apply to every test unless overridden.
5. Fully remove the hard-coded obstacle handler and `dismissObstacles` flag.
6. Only inject dismissal-related AI prompt guidance when the test actually has
   hooks that concern dismissal — when no hooks are configured, the AI is not
   told to dismiss anything.

## Design

### Test-file syntax — `## Hooks` section

Test `.md` files gain an optional `## Hooks` section, structured as a list of
`scope: instruction` entries.

```markdown
## Hooks
- before: Navigate to {{baseUrl}} and accept the cookie banner if visible
- beforeEach: [skill: dismiss_toast_notifications]
- afterEach: Verify no error overlay is visible
- after: Logout of the application
```

Four scopes are supported:

| Scope | When it runs |
|---|---|
| `before` | Once, after browser launch, before step 1 |
| `beforeEach` | Before every step (after `before`, before step N) |
| `afterEach` | After every step (after step N, before step N+1) |
| `after` | Once, after the final step (or on test failure, best effort) |

Multiple entries per scope are allowed — they run in declaration order. Hook
entries may invoke skills and reference `{{parameters}}` exactly like steps.

### Per-step opt-out — `[no-hooks]`

A step can opt out of `beforeEach` and `afterEach` by prefixing `[no-hooks]`:

```markdown
## Steps
1. Open the date picker
2. [no-hooks] Select April 21 2026
3. Submit the form
```

This is essential for steps that interact with UI the hooks would otherwise
dismiss (modals, popovers, toasts the test genuinely wants).

### Project-level defaults — `execution.defaultHooks`

Projects can declare default hooks in `aiui.config.json`:

```json
{
  "execution": {
    "defaultHooks": {
      "beforeEach": ["[skill: dismiss_obstacles]"]
    }
  }
}
```

Per-test `## Hooks` entries **merge** with project defaults (defaults run
first, then test-file hooks). A test can disable defaults for a given scope by
declaring `- beforeEach: none` (or by adding `hooks: replace` to frontmatter to
ignore project defaults entirely).

### Execution semantics

Hook instructions are **regular steps** — they flow through the same
`executeStep` path as the test body. This means:

- They appear in the HTML report, labeled `[hook: beforeEach]` (or similar).
- They support the same action vocabulary (click, type, assert, dismiss, etc.).
- They support `{{parameter}}` interpolation.
- They can invoke `[skill: ...]`.
- They respect the global AI turn/retry machinery.

Hook steps get their **own retry budget**, independent of the step they wrap.
A failing `beforeEach` does not count against the main step's retries, and
does not implicitly retry the main step. A hook failure is reported and
aborts the test (configurable later if needed — v1 just aborts).

`before` / `after` hook failures:
- `before` failure: abort the test immediately, mark as failed.
- `after` failure: log a warning, do not change the test's pass/fail state.
  (Teardown shouldn't be able to falsely fail a passing test.)

### AI prompt gating

Rule #6 in `src/ai/prompts.ts` ("If you encounter an unexpected
popup/modal/banner, return a 'dismiss' action first") and the retry-time
`hasModal` / `hasErrorOverlay` nudges (lines 416-420 and 437-439) are **only
injected when the test has at least one hook configured in any scope** (after
merging project defaults). Rationale: if the author has expressed no intent to
dismiss anything, we shouldn't suggest it. When hooks are present — even
unrelated ones — the prompt guidance becomes available because the author has
signalled they're thinking about pre/post-step behaviour.

A finer-grained trigger (only when a hook specifically handles dismissal) is
out of scope for v1; the simple on/off gate is already a large improvement
over unconditional injection.

### Removal of legacy mechanism

- Delete `src/browser/obstacle-handler.ts`.
- Delete the call site in `src/runner/step-executor.ts` (currently lines
  308-311).
- Remove `execution.dismissObstacles` from `ExecutionConfig`, defaults, and
  all test files that set it.
- Remove the three prompt blocks in `src/ai/prompts.ts` in favour of
  conditional injection based on hook presence.

## Parser changes

`ParsedTest` gains:

```ts
interface TestHooks {
  before: string[];
  beforeEach: string[];
  afterEach: string[];
  after: string[];
}

interface ParsedTest {
  // ...existing fields...
  hooks: TestHooks;
}
```

`parseSections` in `src/parser/markdown.ts` gains a `hooks` branch that
recognises `## Hooks` and parses `- scope: instruction` entries.

Skills are expanded inside hooks with the same `expandSkills` call already
applied to steps.

Per-step `[no-hooks]` markers are stripped at parse time and recorded as a
parallel `skipHooks: boolean[]` array on `ParsedTest`, indexed alongside
`steps`. (Alternative considered: encode as an object `{ text: string,
skipHooks: boolean }[]` — rejected for v1 to minimise downstream churn.)

## Runner changes

`runTest` in `src/runner/test-runner.ts`:

1. After browser launch and `baseUrl` navigation, run `before` hooks as pseudo-steps
   with index `B1`, `B2`, ….
2. For each real step at index `i`:
   - If `skipHooks[i]` is false: run `beforeEach` hooks (indices `i.pre.1`,
     `i.pre.2`, …).
   - Run the step itself (unchanged).
   - If `skipHooks[i]` is false: run `afterEach` hooks (indices `i.post.1`, …).
3. After the final step (or on abort, best effort): run `after` hooks.
4. Hook step results are collected in the same `stepResults` array so they
   surface in the report with distinct labels.

## Config changes

`ExecutionConfig`:

```ts
export interface ExecutionConfig {
  // ...existing fields (minus dismissObstacles)...
  defaultHooks?: {
    before?: string[];
    beforeEach?: string[];
    afterEach?: string[];
    after?: string[];
  };
}
```

## Example — test-app demo

The test-app serves a `dashboard.html` with a cookie banner and error overlay.
A new fixture `fixtures/tests/hooks-demo.md` exercises the new mechanism with:

- A `before` hook that navigates and logs in.
- A `beforeEach` hook that dismisses cookie banners / toasts via a new
  `dismiss_obstacles` skill.
- A `[no-hooks]` step that opens a date picker (so the dismiss skill doesn't
  close it).
- An `after` hook that logs out.

## Migration

`dismissObstacles: true/false` in `aiui.config.json` and in existing test
files is ignored with a warning logged on startup. Authors who relied on
automatic dismissal can add:

```ts
execution: {
  defaultHooks: { beforeEach: ['[skill: dismiss_obstacles]'] },
},
```

to their project config to get equivalent behaviour — now expressed as an
AI-driven skill they can inspect and edit.

## Open questions (deferred)

- Should hooks have their own `maxTurns` override? (v1: share global.)
- Named hooks (`- beforeEach [banner]: ...`) for selective opt-in via
  `[only-hooks: banner]`? (v1: no, all-or-nothing.)
- Async / parallel `before` + navigation? (v1: strictly serial.)
