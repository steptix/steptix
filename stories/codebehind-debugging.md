# Code-behind debugging — breakpoints in `.steps.ts`, F11 into a step's code

**Status: built + verified 2026-08-26** (branch
`claude/codebehind-debugging-breakpoints-8a9128`, Steptix 0.5.98, rebased
onto main at 95aa7e9). Root vitest 3044/3044, runner-core 472/472, extension
unit 399/399 + integration 259/259, `tsc --noEmit` clean on both roots. Live
proof:
[scripts/codebehind-debugger-e2e.mjs](../scripts/codebehind-debugger-e2e.mjs)
against a real `--inspect` server observed the actual `Debugger.paused` at the
cooperative pause via raw CDP, and decoded the bundled module's inline
sourcemap to the canonical `.steps.ts` (the F9 binding contract). Still
manual, by the same constraint tool step-into shipped under: the
`vscode.debug.startDebugging` attach itself, and the F9-hits-in-the-editor
hand check (Extension Development Host checklist in §Test plan).

## In plain terms

A compiled test runs its steps as TypeScript — the `.steps.ts` file sitting
next to the test. When one of those entries misbehaves, today's options are
`ctx.log(...)` archaeology or reading the replay report. What you actually want
is what you'd do in any other TypeScript file: put a breakpoint on the line,
run the test, and land in the debugger with live variables, the real `page`
handle, and step-over/step-into.

This story makes exactly that work, two ways:

**Breakpoints just bind.** Press F9 inside a `run()` in `securebank.steps.ts`,
run the test from Steptix. When the run reaches that step, VS Code pauses on
your line — in your file, not in a bundle — with the entry's `ctx`, `page` and
locals inspectable in the standard debug UI. Continue, and the run carries on.

**F11 steps into a bound step.** A run is paused on a step that carries the
`</>` code mark. Press F11. VS Code's debugger attaches to the server, and you
land at the top of that step's `run()` — no breakpoint needed first. This is
the exact sibling of tool step-into (F11 on a `[tool: ...]` line), which
already ships; code-behind entries get the same treatment.

### What it looks like in practice

**You set** a breakpoint on the `await ctx.page.getByRole(...)` line in
`tests/securebank.steps.ts` and press Run on `tests/securebank.md`.
**You get:** the run starts, a debug session named "Steptix: server"
attaches automatically (status bar: `Steptix: attached debugger for
.steps.ts breakpoints`), the first two steps replay green, and on step 3 VS
Code pauses on your line. The Variables pane shows `ctx`, the Debug Console
evaluates `await ctx.page.title()` against the live browser. F5 resumes; the
step passes; the run finishes.

**You are paused** at a breakpoint on step 5 of the test, whose gutter shows
the `</>` mark, and you press F11.
**You get:** the debugger attaches (or is reused), the status bar says
`Steptix: stepping into code-behind for step 5 — use the Debug toolbar`,
and execution stops at a `debugger;` pause one Step Over away from the entry's
`run()` body. Step through it; when `run()` returns, the Steptix arrow moves
on as usual.

**You press F11** on a paused step with no code-behind entry.
**You get:** exactly what F11 does today — the run advances one step and
pauses again. No error, no debugger; the flag simply had nothing to trigger on.

**You run** with a `.steps.ts` breakpoint set but the server has no inspector
(started without `--inspect`).
**You get:** the run proceeds normally, plus one status-bar line: `Steptix:
server has no inspector — .steps.ts breakpoints won't bind (restart it with
--inspect)`. Nothing hangs, nothing fails.

## Why this is nearly free

The load path was built for it. A `.steps.ts` is imported through the tool
layer's esbuild bundle-per-load ([src/tools/reload.ts](../src/tools/reload.ts),
issue 033): `sourcemap: 'inline'`, with `absWorkingDir` anchored to the cache
dir precisely so the map's `sources` resolve back to the author's real
`.steps.ts` — the comment in `bundleToolModule` calls it the step-into-critical
bit. The entry's `run(ctx)` then executes **in the server process**
([src/runner/step-executor.ts](../src/runner/step-executor.ts) →
[src/codebehind/execute.ts](../src/codebehind/execute.ts)). So once VS Code's
Node debugger is attached to the server, source breakpoints in `.steps.ts`
bind through the inline sourcemap with no further machinery — vscode-js-debug
reads the map off each parsed script; the temp `.mjs` being deleted after
import is irrelevant (the map travels inline, and the mapped sources are real
on-disk files).

Attachment itself also ships already, for tools: the server publishes its
inspector ws URL on `/health` (unauthenticated by design; the URL's UUID is
the secret), the extension records it per-run and has hardened attach logic
(`resolveInspectorTarget`, `shouldReuseDebugSession` in
[inspector-target.ts](../steptix-vscode/src/extension/inspector-target.ts)),
and the serverAutoStart command already carries `--inspect=0`.

What's missing is only the two triggers:

1. nothing attaches the debugger when the user has plain F9 breakpoints (today
   the only attach trigger is F11 on a `[tool: ...]` line), and
2. F11 on a code-behind step has no cooperative pause point, so there is no
   zero-breakpoint way to land at an entry's `run()`.

## Design

### Flow 1 — auto-attach for `.steps.ts` breakpoints

At run start, after the pre-run health probe has answered (so the inspector
URL is known), the extension checks whether any **enabled** source breakpoint
sits in a file ending `.steps.ts`. If yes, and the run targets a local server,
it attaches the same `pwa-node` config tool step-into uses — unless a matching
debug session is already active (`shouldReuseDebugSession`). Then the run
proceeds; module load and step execution happen after the attach, so the
breakpoints bind in time.

Decisions and consequences:

- **The trigger is the breakpoint, not the run.** No breakpoints in any
  `.steps.ts` ⇒ no attach, zero change to today's runs. This is also why the
  check is cheap enough to run on every batch (continuations re-probe anyway).
- **Filename heuristic, not binding knowledge.** The extension does not know
  which steps bind (that's server-side matching); it only needs "the user
  wants to debug steps code". Any enabled breakpoint in any `*.steps.ts` is
  that signal. A stale breakpoint in an unrelated project's steps file causes
  at most a harmless attach.
- **Failure is a note, never a broken run.** No inspector / remote server /
  attach refused ⇒ one status-bar message, run continues undebugged. Mirrors
  the tool flow's ack-and-exit stance.
- **The hook lives on the controller's server-options bag**
  (`onServerReady`), injected from `extension.ts` like `healthProbe` /
  `spawnServer` are — the integration harness can't exercise
  `vscode.debug.startDebugging` (a real attach attempt hangs ~10 s), so the
  decision pieces stay pure and injectable. Batch (Test Explorer) controllers
  do not get the hook, consistent with batch runs ignoring `.md` breakpoints;
  if a debugger is already attached from an editor run, batch runs still pause
  on hit breakpoints, which is normal VS Code behaviour.
- Setting: `steptix.autoAttachStepsBreakpoints` (boolean, default
  `true`) to turn the whole flow off.

### Flow 2 — F11 into a code-behind step

Mirror of tool step-into, one seam over. The client cannot tell which prose
lines carry entries (matching is server-side, and that's fine): F11 on a
paused line that is **neither** a `[tool: ...]` **nor** a `[skill: ...]` line
arms a one-shot server flag, `pauseAtNextCodeBehind`. The server consumes the
flag at the next step it executes:

- step has a bound entry ⇒ emit `codebehind:awaiting-debugger { file, line,
  frame? }`, park on the existing per-session debugger-ack promise, and — once
  the client acks — run the step with a cooperative `debugger;` immediately
  before `entry.run(ctx)`.
- step has no entry (or it was discarded by mid-run healing) ⇒ the flag is
  consumed silently and F11 degrades to today's plain step-into pause.

Why the flag is consumed unconditionally at the next step rather than parked
until some future bound step: F11 means "descend into *this* step". A flag
that lingered would ambush a later step in the run — the exact bug class the
tool flow's run-control 409 test exists to prevent.

The skill-line exclusion matters: F11 on `[skill: ...]` must keep meaning
"pause on the skill's first step in the `.md`", not "jump into whatever
code-behind that first step has". Descending *further* is then one more F11
from inside the skill body.

Client-side, both F11 branches send the flag the same way the tool flag
travels: `run-control` body when step-paused, the initial steps-request body
when relaunching from a breakpoint pause.

The ack round-trip reuses `POST /sessions/:id/tool-debugger-ack` and the
per-session `pendingDebuggerAck` resolver unchanged — the ack means "a
debugger is attached to your process, proceed to your pause point", which is
not tool-specific. The route name stays for wire compatibility.

### Wire protocol (runner-core)

Additive, version-skew safe in both directions — old servers never see the
flag's effects, old clients never receive the event (only the new client
sends the flag):

```ts
// StreamStepsRequest gains
pauseAtNextCodeBehind?: boolean;

// runControl(sessionId, mode, opts) gains
opts?: { pauseAtNextTool?: boolean; pauseAtNextCodeBehind?: boolean }

// New RunEvent variant
export interface CodeBehindAwaitingDebuggerEvent {
  type: 'codebehind:awaiting-debugger';
  /** Absolute path of the `.steps.ts` whose entry is about to run. */
  file: string;
  /** 1-based source line of the step in its test/skill file. */
  line: number;
  frame?: FrameInfo;
}
```

`isRunEvent` learns the new type; the MCP client's ignore lists
([src/mcp/api-client.ts](../src/mcp/api-client.ts),
[src/mcp/run-fold.ts](../src/mcp/run-fold.ts)) name it explicitly — the MCP
surface has no debugger (stories/mcp-server.md non-goal) and never sends the
flag, so it can only ever see the event by a future bug; listing it keeps the
"unknown event" warning honest.

### Server (src/)

- `session-manager.ts`: `pauseAtNextCodeBehind` on the request type and the
  session (one-shot, same lifecycle as `pauseAtNextTool`, including the
  "set only after run-control was actually delivered" guard);
  `setPauseAtNextCodeBehind` pass-through for the run-control route. In the
  step loop's non-tool branch: consume the flag before `executeStep`; when the
  step's binding has an entry, emit the event, park on the ack (the park is
  extracted into a helper shared with the tool branch so the abort semantics
  can't diverge), and thread `codeBehindPauseBeforeRun: true` into the step
  options.
- `api-server.ts`: forward `pauseAtNextCodeBehind` on the steps body and the
  run-control body (the validator is an allow-list; an unnamed field is
  silently dropped — the Phase 3 lesson, and why a real-HTTP test is
  mandatory).
- `step-executor.ts` → `codebehind/execute.ts`: `pauseBeforeRun` option on
  `runCodeBehindEntry`; a guarded `debugger;` directly before
  `entry.run(ctx)`, same idiom and comment shape as
  [src/tools/executor.ts](../src/tools/executor.ts). No-op without an
  inspector by construction, but it is only ever armed after an ack.

The CLI runner is untouched: `steptix run` under a debugger (`node --inspect-brk
dist/index.js run …`) already pauses on `.steps.ts` breakpoints via the same
sourcemapped loader; nothing to add.

### Extension (steptix-vscode/)

- `extension.ts`: the attach block of `handleToolAwaitingDebugger` is factored
  into a shared `attachServerDebugger(controller)` (local-server check →
  `resolveInspectorTarget` → reuse-or-`startDebugging`); the tool handler, the
  new `codebehind:awaiting-debugger` handler (attach → ack, ack-and-exit on
  any failure), and the auto-attach hook all call it. The debug session name
  becomes the shared "Steptix: server".
- `commands/index.ts`: both F11 branches classify the paused line — tool ⇒
  `pauseAtNextTool` (unchanged), skill ⇒ neither flag, anything else ⇒
  `pauseAtNextCodeBehind`.
- `run-controller.ts`: plumb the new flag through `sendRunControl` and the
  initial request body; call the injected `onServerReady` hook after the
  pre-run probe resolves to "proceed" (including the legacy path, where the
  settings fallback supplies the target).
- `inspector-target.ts`: `stepsFileBreakpoints(paths)` — the pure filter the
  auto-attach decision rests on, testable without VS Code.
- `package.json`: the new setting + patch version bump.

## Limits and edge cases

- **A hit breakpoint freezes the whole server process** — HTTP, SSE, every
  other session, the AI loop. Inherent to in-process execution and already
  true of tool step-into's `debugger;`. Fine for a debug session on a local
  dev server; don't debug on a server other runs share.
- **Pauses longer than ~5 minutes can drop the client's SSE stream**: the
  extension consumes SSE via undici's fetch, whose default body timeout is
  300 s, and a paused server sends nothing (its timers are frozen too, so
  heartbeats can't help). The server-side run survives and resumes correctly;
  the extension's live gutter/log for that run degrades. Pre-existing for
  tool step-into; documented here, transport fix (node:http or a dispatcher
  override) is a follow-up if real sessions hit it.
- **Compile replays don't hit canonical-file breakpoints.** A compile's
  replay imports the *candidate* file (`candidateFiles` override in
  [src/codebehind/loader.ts](../src/codebehind/loader.ts)), so its sourcemap
  points there, not at your `.steps.ts`. Debug via a normal run/replay. F11's
  cooperative pause is line-based, not sourcemap-based, but compile runs
  never send the flag either.
- **Remote `STEPTIX_SERVER_URL`** ⇒ both flows decline with the same status-bar
  message tool step-into uses. The inspector URL from `/health` is only ever
  dialled when it parses to a loopback host.
- **Breakpoint on module top-level code** (outside any `run()`): binds and
  hits during registry build at batch start — before the first `step:start`.
  Works, just don't be surprised that the pause precedes the arrow.
- **`ai: true` entries and unbound steps** have no code to pause in; F11
  degrades to a plain step pause.
- **Two attach paths racing** (auto-attach at run start + F11 later in the
  same run): the second finds `shouldReuseDebugSession` true and does
  nothing. Same as consecutive tool F11s today.

## Test plan

- **Server, through real HTTP** (`tests/api-server-codebehind-debugger.test.ts`,
  modelled on `api-server-tools.test.ts`): `pauseAtNextCodeBehind` on the
  steps body emits `codebehind:awaiting-debugger` for a bound step and parks
  until the ack route resolves it; the flag is one-shot (second bound step
  runs without an event); a step with no entry consumes the flag silently;
  run-control delivery guard (409 does not leave the flag armed); event
  carries the canonical `.steps.ts` path and the step's source line.
- **runner-core** (`node --test`): `isRunEvent` narrows the new variant;
  `runControl` posts the new opt.
- **Extension integration** (`codebehind-debugger.test.cjs`, modelled on
  `tool-debugger.test.cjs`): F11 while step-paused on a plain line sends
  `pauseAtNextCodeBehind: true`; on a `[tool:]` line sends `pauseAtNextTool`
  and not the code-behind flag; on a `[skill:]` line sends neither; the
  breakpoint-relaunch branch seeds the initial body the same way.
- **Pure units**: `stepsFileBreakpoints` filter; existing
  `resolveInspectorTarget` / `shouldReuseDebugSession` suites already cover
  the attach decision.
- **Manual / live** (attach can't run in the harness — established in the
  Phase 5 work):
  [scripts/codebehind-debugger-e2e.mjs](../scripts/codebehind-debugger-e2e.mjs)
  drives a real `--inspect` server: park→ack, then a raw CDP client observes
  the actual `Debugger.paused` at the cooperative `debugger;`, resumes, and
  decodes the bundled module's inline sourcemap to assert `sources[0]`
  resolves to the on-disk `.steps.ts` (with `sourcesContent`) — the exact
  contract vscode-js-debug binds F9 breakpoints against. What stays a hand
  check in the Extension Development Host: F9 in a steps file → breakpoint
  hits in the editor; F11 on a `</>` step → lands at `run()`.

## Non-goals

- Debugging AI-driven steps (nothing to step through), or the compile
  pipeline's internals.
- Conditional/hit-count breakpoints — VS Code owns breakpoints wholesale
  here, so whatever js-debug supports works; nothing Steptix-specific.
- Edit-and-continue of `.steps.ts` mid-run. Edits apply on the next batch
  (bundle-per-load) as they do today.
- Remote-server debugging.
