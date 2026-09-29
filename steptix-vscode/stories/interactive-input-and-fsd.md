# Spec: `[input:]`, `[interactive]`, and FSD-on-failure in Steptix

Status: Proposed
Owner: Steptix
Last updated: 2026-04-28

## Background

The CLI runner (`src/runner/test-runner.ts`) supports three pause-for-user
modes that the Sessions API server currently skips:

- `[input: varName] prompt text` — pauses, stores the typed value as a
  `{{varName}}` parameter for later steps
- `[interactive] hint` — opens a REPL where each typed line executes as an
  ad-hoc AI step until the user types `done` / `exit`
- **FSD-on-failure** — when `config.execution.interactiveOnFailure` is true,
  a failed step drops into `src/runner/fsd-repl.ts` for triage / resume /
  abort

`session-manager.ts:601` returns these as "skipped" in API mode. The
Steptix webview talks to the API server, so today none of them work in
the extension.

## Goal

Make all three modes usable inside the VS Code extension, with the user
typing into the existing webview — no terminal, no modal popup — and
**without changing the server protocol**.

## Non-goals

- Implementing pause/resume of the AI model mid-step (that's a separate
  server feature; breakpoints have the same constraint today).
- Migrating the Electron runner. It already uses readline; adapting it to
  the new flow is a v2 task.
- Persisting `[input:]` values across runs. Each run prompts fresh.
- `:resume` REPL command from FSD. It's CLI-runner-specific and predates
  the session-aware execution model.

## Architecture: client-orchestrated, not server-blocking

The webview already has the full source text and the line set the user
selected. The **run-controller (host)** becomes a small state machine that
classifies each selected step and decides whether to call the server or
prompt the user:

```
classify(line) → step | input(var, prompt) | interactive(hint)

run loop:
  while pending:
    take the next contiguous block of `step` entries
    streamSteps(...)   ← one HTTP request
    on `step:fail` and FSD enabled: enter interactive mode at this line
    when done, advance

    if next is `input(var, prompt)`:
      post {type:'prompt', mode:'input', message:prompt, varName:var}
      await {type:'promptResponse', text}
      parameters[var] = text
      advance

    if next is `interactive(hint)`:
      post {type:'prompt', mode:'interactive', message:hint}
      loop:
        await {type:'promptResponse', text}
        if text in {done, exit, :exit, :quit}: break
        if text starts with ':' → REPL command (handled in host, no server call)
        else: streamSteps(one step) and surface events
      advance
```

The server sees only "real" steps. The existing skip-logic in
`session-manager.ts` remains as a safety net but is never reached.

### Why client-side is the right call

- **No protocol change.** SSE stays one-way; no new endpoint for
  "respond to a prompt"; no long-blocking HTTP requests.
- **Source of truth stays in the file.** The `[input:]` / `[interactive]`
  markers are just text the client recognizes. The server's job stays
  narrow: execute one step.
- **REPL commands stay local.** `:list`, `:exit`, etc. are pure UI
  affordances, no server round-trip.

The tradeoff: each chunk of normal steps is its own `streamSteps` request,
so a test with N `[input:]` markers makes N+1 requests (vs. one batch).
The server already handles serial requests against the same session ID
correctly, so this is fine.

## Webview UI: composer in the output-log panel

A textarea pinned to the bottom of the **existing output-log panel** (right
side, the one with its own scrollbar). Hidden by default; reveals on a
`prompt` message from the host.

```
┌─ OUTPUT LOG ─────────────┐
│ ✓ Step 1 passed          │
│ ✓ Step 2 passed          │
│ … log scrolls …          │
├──────────────────────────┤
│ ⏸ Waiting for input      │  ← yellow banner
│ Enter your username:     │  ← prompt message
│ ┌──────────────────────┐ │
│ │ user types here      │ │  ← textarea
│ └──────────────────────┘ │
│             [Cancel] [▶] │
└──────────────────────────┘
```

- `Enter` submits, `Shift+Enter` inserts newline.
- `Cancel` posts `promptCancel` → host aborts the run with
  `aborted` status, same as Stop.
- The banner color matches the existing breakpoint paused indicator
  (yellow `#fbbf24`-family).
- For `[interactive]` mode the textarea stays after each submit; the log
  shows `> <user text>` and the resulting AI step events as normal.

### REPL commands accepted in `[interactive]` mode

Handled in the host without server calls. Commands are `/`-prefixed; see
[stories/unified-interactive-repl.md](../../stories/unified-interactive-repl.md)
for the canonical surface.

| Command       | Effect                                                  |
|---------------|---------------------------------------------------------|
| `/help`       | Echo the list of commands into the log                 |
| `/list`       | Echo all step lines from the source file               |
| `/continue`   | End the interactive block, run continues               |
| `/exit`       | End the run entirely (same as Stop; alias `/quit`)     |

Deferred in the steptix: `/screenshot` (needs a server endpoint),
`/resume` (run-controller currently can't jump). Both surface a
"not yet supported in the steptix" warning when typed; the CLI runner
honours both. Bare-word `done` / `exit` and the previous-design `:`-prefix
inputs print a one-line deprecation hint pointing at the new command.

## Protocol additions

### Host → Webview

```ts
interface HostPromptMsg {
  type: 'prompt';
  mode: 'input' | 'interactive';
  message: string;       // shown above the textarea
  varName?: string;      // for `mode === 'input'`, the {{var}} we're filling
}

interface HostPromptDoneMsg {
  type: 'promptDone';   // host got the answer (or cancel); webview hides composer
}
```

### Webview → Host

```ts
interface WebviewPromptResponseMsg {
  type: 'promptResponse';
  text: string;          // raw user input (newlines preserved)
}

interface WebviewPromptCancelMsg {
  type: 'promptCancel';
}
```

Both add to the discriminated unions in `runner-core/src/protocol.ts`.

## FSD-on-failure (deferred behind a flag)

When a `step:fail` event arrives during a normal run AND the test file's
`## Config` block has `interactiveOnFailure: true`, the host enters the
same `[interactive]` mode at the failing line. The user can type
ad-hoc instructions to triage; typing `:exit` ends the run with the
failure preserved in the report.

For v1 we **defer FSD** entirely — the failed step is reported as normal
and the user can press F5 from a later line manually. Implementation is
straightforward once `[interactive]` is in: same composer, same protocol,
different trigger.

## Step classification

```ts
const INPUT_PATTERN = /^\[input:\s*(\w+)\]\s*(.*)$/i;
const INTERACTIVE_PATTERN = /^\[interactive\]\s*(.*)$/i;

type Classified =
  | { kind: 'step'; line: number; instruction: string }
  | { kind: 'input'; line: number; varName: string; prompt: string }
  | { kind: 'interactive'; line: number; hint: string };
```

The run-controller already calls `extractSteps` on the document text;
classification slots in alongside that.

## Failure modes

| Scenario                                  | Behavior                                                  |
|-------------------------------------------|-----------------------------------------------------------|
| User cancels prompt                       | Run aborts with status `aborted`, same UX as Stop         |
| User submits empty `[input:]` value       | Allowed — empty string stored. Test author can validate.  |
| `[interactive]` REPL step fails           | Logged as fail, REPL stays open — user can keep trying    |
| Multiple `[input:]` for same `varName`    | Each prompt is independent; later overwrites earlier      |
| User runs only the `[input:]` line via F5 | Prompt fires, value is stored, but no later step uses it  |
| Network drops during `[interactive]`      | Surface `STX014` as today; REPL closes; run aborts         |

## Out-of-scope clarifications

- **Webview does not need to know `parameters` are being collected.** The
  host injects them into the next `streamSteps` request body.
- **`[input:]` values are NOT sent to the server's process env.** They go
  into the per-request `parameters` object only — same isolation
  guarantee as `## Parameters`.
- **Selection runs (F5 on a subset)** behave the same as full runs:
  selected `[input:]` lines prompt; unselected ones are simply not part
  of the chunk and nothing is asked. If a later selected step references
  a `{{var}}` that was never collected, the server resolves it as the
  literal `{{var}}` string — not an extension concern.

## Implementation outline

1. **`runner-core/src/protocol.ts`** — add the four message types above
   to the unions and narrowing helpers.
2. **`runner-core/src/step-meta.ts`** (new, or extend `step-lines.ts`) —
   add `classifySelectedLines(text, lines)` returning `Classified[]`.
3. **`steptix/src/extension/run-controller.ts`** — refactor
   `runLines` from "one stream" into a state-machine that walks the
   classified array, awaits prompt responses, and merges parameters.
4. **`steptix/src/extension/editor-provider.ts`** — wire
   `promptResponse` / `promptCancel` to the controller.
5. **`steptix/src/webview/lib/host-bridge.js`** — `postPromptResponse`,
   `postPromptCancel`.
6. **`steptix/src/webview/steptix-runner.jsx`** — composer panel
   pinned under the output log; React state for `pendingPrompt` and
   `interactiveMode`; REPL command handler.
7. **Tests** — unit-test the classifier and the controller's state
   machine with a stubbed ApiClient.

## Open questions for review

- Should `[input:]` values **echo into the log** as they're collected, or
  stay silent for password-style prompts? Recommend: echo a masked line
  (`> *****`) when `varName` matches `/password|secret|token/i`,
  otherwise echo plainly.
- Should `[interactive]` user lines be persisted back to the test file
  (so the user can promote a successful ad-hoc step to a real step)?
  Recommend: no for v1, add a "Save as step" button later.
- Should `Cancel` differ from Stop? Recommend: identical for v1.
