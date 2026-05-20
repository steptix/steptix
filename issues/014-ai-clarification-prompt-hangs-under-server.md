# 014 — AI clarification prompt hangs the run under the Sessions API server

**Status:** partially resolved — option A (fail-fast safety valve) shipped; option B (first-class clarification over SSE) still open
**Update (2026-05-20):** Option A landed. `StepExecutorOptions.nonInteractive` ([src/runner/step-executor.ts](../src/runner/step-executor.ts)) makes a clarification request fail the step fast — with the AI's question as the error — instead of calling `readline`; the session manager passes `nonInteractive: true` ([src/server/session-manager.ts](../src/server/session-manager.ts)). No run can hang anymore. Regression test: [tests/clarification-noninteractive.test.ts](../tests/clarification-noninteractive.test.ts). **Option B below is the remaining work** — making the question answerable in the TestBench UI rather than only surfaced as a failure.
**Area:** [src/runner/step-executor.ts:593-604](../src/runner/step-executor.ts#L593-L604) — `prompt` action handling; [src/runner/step-executor.ts:2020-2090](../src/runner/step-executor.ts#L2020-L2090) — `promptUserWithReplEscape` / `promptUser` (Node `readline` on `process.stdin`)
**Related:** [src/server/session-manager.ts](../src/server/session-manager.ts) — `executeStepsInternal` calls `executeStep` with no clarification handler; [testbench-native/src/extension/run-controller.ts](../testbench-native/src/extension/run-controller.ts) — `requestPrompt` (the existing `[input:]` / `[interactive]` prompt UI); endpoint precedents `run-control` + `tool-debugger-ack`
**Opened:** 2026-05-20

## Summary

When the AI returns a `prompt` action (ambiguity resolution) and
`execution.promptOnAmbiguity` is on, the step executor asks the question
through Node `readline` bound to **the current process's stdin/stdout**:

```typescript
// step-executor.ts:595
if (promptAction && config.execution.promptOnAmbiguity) {
  const question = promptAction.question ?? promptAction.description;
  const outcome = await promptUserWithReplEscape({ question, page, ... });
  // ...
}
// step-executor.ts:2038 — inside promptUserWithReplEscape
const rl = readline.createInterface({ input, output });   // process.stdin / stdout
const raw = await reader.question('  Your answer: ');
```

That works for the **CLI** (`aiui run`), where `executeStep` runs in the
same terminal the user is sitting in. But under the **Sessions API
server** (the path TestBench-native drives), `executeStep` runs inside
the long-lived server process. There is no interactive console for the
end user, so:

1. The question text is written to the **server's** stdout (the
   `aiui serve` / `npm run dev` console) — invisible to the TestBench
   user.
2. `rl.question(...)` blocks on the server's stdin, which nobody is
   typing into → the SSE stream stalls → **the test hangs** with no
   event telling the client a question was even asked.

There is no SSE event for the clarification and no endpoint to deliver
an answer, so the client can neither show the prompt nor unblock it.

## Why TestBench can't see it today

Compare with `[input: ...]` / `[interactive]`, which *do* prompt cleanly
in the UI: those are classified **client-side** in `run-controller.ts`,
which posts a `prompt` webview message and awaits the answer
(`requestPrompt`). The AI's mid-step clarification is generated
**server-side** during `executeStep`, after the request is already
streaming — the client never gets a turn, and the executor's only ask
channel is `readline`.

## Options

### A. Safety valve — don't hang (small, ship now)
Under the server, treat a `prompt` action as a **terminal step failure**
whose error message is the AI's question (instead of calling
`readline`). Inject a clarification handler into `executeStep` that, in
server mode, throws/returns-failed with
`"AI needs clarification: <question>"`. The run ends as a normal
`step:fail` — which already parks the yellow ▶ + Continue (issue/feature
in `extension.ts`), and the question shows in the report and run log.
Loses interactivity but **kills the hang** and surfaces the question.
Could also be a config flag (`promptOnAmbiguity: false` server-side by
default).

### B. First-class clarification over SSE + answer endpoint (proper fix)
Mirror the `tool-debugger-ack` / `run-control` pattern:
- Add an injectable async handler to `executeStep`'s options,
  `askClarification(question) => Promise<string | { control }>`,
  defaulting to today's `readline` implementation for the CLI.
- The server passes a handler that **emits a new `step:clarification`
  SSE event** (question + line + frame) and parks on a Promise stored on
  the session (like `pendingDebuggerAck`).
- New endpoint `POST /sessions/:id/clarification` resolves the Promise
  with the user's answer.
- `run-controller.ts` handles `step:clarification` by reusing the
  existing `requestPrompt` UI, then POSTs the answer. The REPL escape
  hatch (`/repl`, `/exit`, `/resume`) is either dropped for the UI path
  or adapted to control messages.

This makes AI questions a real, answerable UI affordance — the
interactive clarification flow the CLI has, but in TestBench.

### C. Hybrid (recommended)
Ship **A** immediately so no run can hang, and schedule **B** as the
real feature. A is a precondition for B anyway (both need the
clarification call site to become injectable rather than hard-wired to
`readline`).

## Tests this would need

- Server `/steps` run where the mocked AI returns a `prompt` action:
  - **A:** the run ends with `step:fail` carrying the question; no hang
    (assert the stream terminates within a timeout).
  - **B:** a `step:clarification` event is emitted; posting to
    `/sessions/:id/clarification` resumes the run and the clarified
    answer reaches the follow-up AI call.
- CLI path unchanged: `readline` handler still used, existing
  clarification tests (`test-runner-clarification-control.test.ts`,
  `clarification-prompt.test.ts`) stay green.

## Revisit when

- Now — this hangs a real user workflow with no recovery short of Stop.
  At minimum land option A.
