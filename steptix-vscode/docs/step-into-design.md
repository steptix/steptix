# Step Into — design

Status: draft, pre-implementation. Owner: pkent.
Scope: `steptix-vscode` extension, `runner-core`, server (`src/`).

## Goal

When a Steptix run is paused at a breakpoint on a `[skill: ...]` or
`[tool: ...]` line, the user can **step into** that invocation:

- **Skill**: open the skill's `.md` file, park the yellow pause arrow on its
  first step, and let the existing Run / Pause / Resume / breakpoints /
  Step Over machinery operate inside the skill. Nested skill calls compose
  recursively, building a call stack. When the skill finishes, control
  returns to the **next line in the caller**, with the skill's aliased
  outputs visible in caller scope.
- **Tool**: hand off to VS Code's standard Node.js debugger attached to the
  server process, with execution paused at the tool's `run()` entry — the
  user gets normal TypeScript step-over / step-into / step-out / continue
  inside the `.ts` source.

Plus: a **Variables panel** that shows the current frame's variable scope
(caller vs skill, with output aliases visible at frame boundaries).

## Non-goals

- Stepping inside an *AI-driven* natural-language step. Those remain atomic.
- Editing variable values while paused. Read-only inspection for now.
- Conditional / hit-count breakpoints. The existing breakpoint model stays.
- Remote `SERVER_URL` support for tool step-into. Tool descent requires a
  local server running with `--inspect`; remote setups get a clear
  "feature unavailable" error and skill step-into continues to work.

## User stories

1. **Step into a skill, run to completion.** Author hits F9 on line 12 of
   [fixtures/tests/skill-demo.md](../../fixtures/tests/skill-demo.md), hits F5
   to run. Pauses at the `[skill: duckduckgo_search ...]` line. Hits F11.
   `fixtures/skills/duckduckgo_search.md` opens, arrow on step 1. F10 walks
   through the skill's steps. After the last skill step, the arrow returns
   to line 13 of the test (`Navigate to {{target_url}}`) and `target_url` is
   visible in the Variables panel.
2. **Step into a nested skill.** Same as above but a skill body itself
   contains a `[skill: ...]` line. F11 there descends again; call stack
   shows test → outer skill → inner skill. Step Out (Shift+F11) pops one
   frame at a time.
3. **Step into a tool.** Author hits F9 on a `[tool: ...]` line, hits F5,
   pauses there, hits F11. A VS Code Node debug session attaches (or
   reuses an existing one) and pauses inside the tool's `.ts` file at the
   first executable line of `run()`. The standard VS Code debug toolbar
   drives execution inside the tool. When the tool returns, the steptix
   run resumes and the Steptix UI takes over the arrow again.
4. **Tool step-into without `--inspect`.** Author hits F11 on a `[tool: ...]`
   line but the server wasn't launched with `--inspect`. A
   `vscode.window.showErrorMessage` surfaces a one-line cause + a "How to
   fix" action that opens the docs. Skill step-into is unaffected.
5. **Inspect scope while paused.** While paused (anywhere — top-level,
   inside a skill, inside a nested skill), the Variables panel shows the
   active frame's scope. Switching frames in the call-stack view updates
   the panel.

## Where we are today (one-paragraph recap)

The steptix-vscode run path is line-by-line over the **currently-open
`.md`** file. [run-controller.ts](../src/extension/run-controller.ts)'s
`trimAtBreakpoint` slices the step list at the first breakpoint;
[active-file-tracker.ts](../src/extension/active-file-tracker.ts) tracks the
pause line and renders the yellow arrow via
[decorations.ts](../src/extension/decorations.ts). Skills are flattened
**server-side** at parse time by [src/skills/expander.ts](../../src/skills/expander.ts)
— the extension never sees the expansion. Tools execute inside the server
at [src/tools/executor.ts:164](../../src/tools/executor.ts#L164)
(`def.run(typedArgs, ctx)`). The wire protocol
([runner-core/src/protocol.ts](../../runner-core/src/protocol.ts)) emits
`step:start` / `step:pass` / `step:fail` with a single 1-based `line`
field — there is no concept of an origin file, a frame, or a stack.

## Architecture overview

Three packages touched, each with a distinct responsibility:

| Package | Responsibility |
| --- | --- |
| **server** (`src/`) | Per-call skill expansion (or step-by-step emission with frame info) so the client knows what file/line each emitted step came from. Cooperates on tool-pause via a request flag that injects an inspector pause at the tool dispatcher. Surfaces variable scope snapshots per step. |
| **runner-core** | Protocol additions: frame info on step events, step-mode controls, scope payload, tool-pause flag. Client-side `ApiClient` learns the new request fields and emits the new event variants. |
| **steptix-vscode** | Call-stack model, multi-file yellow-arrow that follows the active frame, Step Into / Step Over / Step Out commands, Variables panel webview, Node-debugger handoff for tool descent, settings for inspector port. |

## Skill step-into

### Conceptual model: frames

The extension grows a **frame stack** keyed by the active run:

```
type Frame = {
  uri: vscode.Uri;          // file the arrow lives in for this frame
  line: number;              // 1-based source line currently paused on
  kind: 'test' | 'skill';
  skillName?: string;        // populated for kind === 'skill'
  scope: Record<string, string>;   // resolved vars at this frame
  // For provenance: which line in the parent invoked this frame
  callerUri?: vscode.Uri;
  callerLine?: number;
};
```

The bottom of the stack is always the test file. Each `[skill: ...]`
descent pushes a new frame; Step Out / falling-off-the-end pops one.

Today `breakpointStop` is a single `number | null` on each tracked
document ([active-file-tracker.ts:245](../src/extension/active-file-tracker.ts#L245)).
That generalises to: the **top frame's `uri` + `line`** carries the
arrow, and the extension renders pause decoration on whatever editor
matches the top frame's URI. Files for non-top frames stay un-decorated
(they're shown in the call-stack view instead).

### Driving execution

Two viable approaches; we'll go with **(B)** because it keeps the server
honest about expansion and lets the extension stay declarative.

- **(A) Client-side recursive expansion.** Move skill expansion into
  `runner-core` so the extension can walk a skill's `.md` itself and send
  *one expanded step at a time* to the server. The server stops doing
  skill flattening for stepped runs. Simpler protocol, more work in the
  client.
- **(B) Server emits per-step frame info.** Keep expansion server-side but
  change the emission contract: `step:start` carries a frame descriptor
  (origin file, origin line, frame id, parent frame id). The extension
  reconstructs the stack from these events. Server gains a "step mode"
  request flag controlling whether it pauses between emitted steps.

Concretely, the protocol gains (additive, optional fields stay backward
compatible — existing clients that ignore them just see the flattened
trace they get today):

```ts
// runner-core/src/protocol.ts — additions
export interface FrameInfo {
  id: string;               // stable per run
  parentId: string | null;  // null at the test frame
  kind: 'test' | 'skill';
  uri: string;              // file:// URI of the step's origin file
  line: number;             // 1-based line in that file
  skillName?: string;       // for kind === 'skill'
}

export interface StepStartEvent {
  type: 'step:start';
  line: number;       // legacy: line in the originally-submitted document
  frame?: FrameInfo;  // NEW: origin frame; absent on legacy servers
}
// step:pass and step:fail gain the same optional `frame` field.

export interface FramePushEvent {  // NEW
  type: 'frame:push';
  frame: FrameInfo;
}

export interface FramePopEvent {   // NEW
  type: 'frame:pop';
  frameId: string;
  // Output aliases that survived this frame, ready to merge into the
  // parent's scope. Extension uses this to update the Variables panel
  // on Step Out / fall-off-end.
  outputs: Record<string, string>;
}
```

Step-mode controls — added to the `streamSteps` request body:

```ts
interface StreamStepsRequest {
  // ...existing fields...
  stepMode?: {
    /** 'continue' = run normally; 'into' = pause before each step,
     *  descending into skill/tool calls; 'over' = pause before each
     *  step, atomic over skill/tool calls; 'out' = run to end of
     *  current frame, then pause. */
    mode: 'continue' | 'into' | 'over' | 'out';
    /** When true, the server pauses immediately before the tool
     *  dispatcher's `def.run(...)` call. Used for tool step-into. */
    pauseAtNextTool?: boolean;
  };
}
```

### Wire-level flow for "Step Into a skill"

1. User paused at test line 12 (frame stack: `[test@12]`). Variables
   panel shows test scope. Yellow arrow on test:12.
2. User hits F11. Extension sends a new request to the server: resume
   from frame top with `stepMode.mode = 'into'`.
3. Server begins executing line 12. It's a skill call. Before executing
   the skill's first step it emits `frame:push` with origin =
   `duckduckgo_search.md` step 1. The runner is still in `mode = 'into'`,
   so it then pauses after `step:start` and waits for the next control
   message.
4. Extension receives `frame:push` → pushes a `Frame` onto its stack,
   opens `duckduckgo_search.md`, parks the arrow on step 1, updates the
   call-stack view and Variables panel.
5. User hits F10. Extension sends `stepMode.mode = 'over'`. Server runs
   the current step to `step:pass`, then pauses before the next.
6. Repeat until the skill emits `frame:pop`. Extension pops the frame,
   merges `outputs` into the now-top frame's scope, advances the arrow
   to the next line in the caller (test:13).

### Hitting breakpoints inside a skill file

Breakpoints already live in `vscode.debug.breakpoints` keyed by URI. The
existing `tracker.breakpoints(uri)` ([active-file-tracker.ts:159](../src/extension/active-file-tracker.ts#L159))
generalises trivially — we just look up by the **frame's** URI when
checking whether to pause. The breakpoint set sent on the wire becomes a
per-frame structure: `Record<uri, number[]>` covering test + every
referenced skill file. The server, knowing each step's origin frame,
checks `breakpoints[frame.uri].includes(frame.line)`.

### Nested skills

Falls out of the model for free: the server emits another `frame:push`
when entering a skill from inside a skill. The extension's stack grows;
the call-stack view shows the chain.

### Edge cases

- **Skill cycle.** Already prevented by [expander.ts:101-104](../../src/skills/expander.ts#L101-L104). No change.
- **Pause during a skill that emits no steps.** Skills with empty step
  lists shouldn't exist (the parser would reject), but if one is reached
  the server emits `frame:push` then immediately `frame:pop` with no
  steps between — the extension pops without parking.
- **Stop while inside a skill.** Existing `stop` command unwinds the
  whole stack; extension clears all frames, hides all yellow arrows.
- **A skill that calls a `[tool: ...]`.** Tool entry pause-flag composes:
  while we're stepping inside the skill, the next `[tool: ...]` line
  honours step-into the same way.

## Tool step-into

Tools are TypeScript executed by the server. The only honest way to
"step into" them is via Node's V8 Inspector. Mechanics:

### Server side: cooperative pause

The server learns one new request flag — `stepMode.pauseAtNextTool` —
and adds a single pause point at the tool dispatcher:

```ts
// src/tools/executor.ts, around line 163
if (options.pauseAtNextTool) {
  // Surface to the client so it can attach the debugger before we
  // hit the inspector pause.
  options.onAwaitingDebugger?.({ toolName: call.name, filePath: ... });
  // Synchronously pause the runtime for the inspector.
  // Either `debugger;` (works only if an inspector is attached) or
  // an explicit `inspector.Session#pause()` call. We'll use
  // `debugger;` and require the client to have attached first.
  debugger;  // eslint-disable-line no-debugger
}
await Promise.resolve(def.run(typedArgs as never, ctx));
```

The dispatcher emits a new event before pausing:

```ts
export interface ToolAwaitingDebuggerEvent {
  type: 'tool:awaiting-debugger';
  toolName: string;
  toolFilePath: string;   // absolute path, .ts source if available
  inspectorPort?: number; // server's --inspect port if known
}
```

This gives the extension a precise moment to attach the debugger before
the `debugger;` statement is reached.

### Client side: attach + handoff

1. User paused at a `[tool: ...]` line, hits F11.
2. Extension validates the server is local (its `SERVER_URL` resolves to
   `127.0.0.1` / `localhost`). If not, errors with "Tool step-into
   requires a local server" and bails.
3. Extension issues a resume request with `stepMode.pauseAtNextTool = true`.
4. Server emits `tool:awaiting-debugger { toolName, toolFilePath,
   inspectorPort }`.
5. Extension calls `vscode.debug.startDebugging(undefined, {
   type: 'node', request: 'attach', name: 'Steptix tool',
   port: inspectorPort, skipFiles: ['<node_internals>/**', ...] })`.
   If a Node debug session is already attached to that port, reuse it.
6. Once attached, extension acknowledges via a new
   `WebviewToolAttachedMsg`-equivalent request (`POST /run/{runId}/ack-debugger`).
   Server lets execution proceed past the `debugger;` statement, which
   pauses the Node runtime — VS Code's debugger UI now owns the show.
7. While the Node session is paused, steptix-vscode's own UI shows
   "Stepping inside tool: `<name>` — use the Debug toolbar." The
   yellow arrow stays parked on the `[tool: ...]` line.
8. When the Node session resumes past the tool body (`def.run` returns),
   the server emits the usual `step:pass`. The extension closes the
   "in-tool" UI, the Node session can stay attached for the rest of the
   run (no point detaching/reattaching for every subsequent tool).

### Configuration

A new VS Code setting:

```jsonc
// .vscode/settings.json or user settings
"steptix.inspectorPort": 9229,    // default Node inspector port
"steptix.inspectorHost": "127.0.0.1"
```

Documentation update telling users to launch the server with
`node --inspect=9229 ...` (or whatever they use today, with `--inspect`
prepended). If the user hits F11 on a tool line and the inspector isn't
reachable, the error message names the exact command they should be
running.

### Why server-cooperative over "extension sets a one-shot breakpoint"

We considered having the extension add a one-shot `SourceBreakpoint` at
the tool's entry function via `vscode.debug.addBreakpoints()`. It works
in principle but it depends on the source-map binding being healthy at
the moment of attachment — a notoriously flaky thing in mixed
build/transpile setups. Cooperative pause (`debugger;` at a known call
site) is one line of server code and has no source-map dependency.

## Variables panel

A new webview, separate from the sidebar runner, registered as a
`vscode.WebviewViewProvider` and contributed under the Steptix
container.

### Data flow

- Server emits `frame:scope` events alongside `step:start` carrying the
  active frame's variable map at that point in execution.
- The extension keeps the current scope per frame. On frame switches in
  the call-stack view, the panel shows the selected frame's scope.

```ts
// runner-core/src/protocol.ts — additions
export interface FrameScopeEvent {
  type: 'frame:scope';
  frameId: string;
  scope: Record<string, string>;
}
```

### Rendering

- Two-column list: name, value. Truncate long values, click to expand.
- Mask values whose names match the existing secret heuristic
  (`maskIfSecret`). Same redaction the run log already uses.
- Header per frame shows the frame's identity (test path, or skill
  name + invocation line) so users see *which* scope they're looking at.
- Output aliases are surfaced at frame boundaries: when a child frame
  pops, the merged aliases highlight briefly in the parent's view
  ("inherited from `duckduckgo_search`: `target_url`").

We roll our own webview rather than reusing VS Code's native "Debug:
Variables" view because the frames are Steptix frames (one per step
in `.md`), not Node frames. Only the tool-step-into case puts the user
inside the standard Debug Variables view, and that's already covered by
the Node debugger session.

## Call-stack view

A second webview view (or a tree view via `TreeDataProvider`) in the
Steptix container:

```
Steptix
├── Runner            (existing sidebar)
├── Call Stack        (NEW)
└── Variables         (NEW)
```

The call-stack view shows one row per frame, top frame highlighted.
Clicking a frame reveals that file/line in the editor and refocuses the
Variables panel on that frame's scope. The bottom-most frame is always
the test file.

## Commands & keybindings

| Command id | Default keybinding | When | Behaviour |
| --- | --- | --- | --- |
| `steptix.stepInto` | F11 | `paused` | Step into the skill/tool on the current paused line. Falls back to "step over" semantics if the line isn't a `[skill: ...]` or `[tool: ...]` invocation. |
| `steptix.stepOver` | F10 | `paused` | Execute one step and pause again. Skill/tool calls are atomic. |
| `steptix.stepOut` | Shift+F11 | `paused` and frame stack > 1 | Run to end of current frame, pause on the caller's next line. Disabled at the test frame. |
| `steptix.resume` | F5 | `paused` (existing) | Unchanged behaviour: continue until next breakpoint or end-of-run. |

Context keys: `steptix.frameDepth: number` (current frame
stack depth) gates `stepOut` visibility. `steptix.paused`
gates the rest (already exists).

## Protocol summary (all additions)

```ts
// runner-core/src/protocol.ts — new event variants
type RunEvent =
  | StepStartEvent          // gains optional `frame: FrameInfo`
  | StepPassEvent           // gains optional `frame: FrameInfo`
  | StepFailEvent           // gains optional `frame: FrameInfo`
  | OutputEvent
  | CaptureEvent
  | DoneEvent
  | FramePushEvent          // NEW
  | FramePopEvent           // NEW
  | FrameScopeEvent         // NEW
  | ToolAwaitingDebuggerEvent;  // NEW

// New request fields on streamSteps
interface StreamStepsRequest {
  // ...existing...
  stepMode?: {
    mode: 'continue' | 'into' | 'over' | 'out';
    pauseAtNextTool?: boolean;
  };
  breakpointsByUri?: Record<string, number[]>;  // generalises today's number[]
}

// New ack endpoint for tool-handoff
POST /run/{runId}/ack-debugger   // body: { attached: true }
```

All additions are optional; servers that don't implement them keep
emitting the legacy flat trace and the extension transparently degrades
to today's behaviour (skill/tool lines stay atomic; Step Into is greyed
out and shows a tooltip explaining the server doesn't support it).

## Phased delivery

The work is large enough to benefit from horizontal slices.

### Phase 1 — Frames over the wire (skills only, no UI yet)
- runner-core: protocol additions (`frame:push`, `frame:pop`,
  `frame:scope`, frame field on step events).
- server: emit frames during skill expansion. Existing
  expander.ts becomes a step-iterator that emits frame events
  between expanded steps. No step-mode pausing yet — server runs
  through normally.
- Tests: integration test that runs `skill-demo.md` and asserts the
  emitted event sequence includes a `frame:push` / `frame:pop`
  surrounding the skill body.

### Phase 2 — Extension call-stack model + arrow follows frames
- Extension: `RunController` consumes frame events, maintains a frame
  stack, drives the yellow arrow to the top frame's URI+line.
- Behaviour for a normal run is **unchanged from the user's view**
  (frames are just an internal representation), but the arrow may
  cross files during a skill body.
- Call-stack view added (read-only, no clicks-to-navigate yet).

### Phase 3 — Step Into / Over / Out for skills
- runner-core: `stepMode` field on the request.
- server: respect `stepMode`, pause between steps when `mode === 'into'`
  or `'over'`. Resume-control endpoint: `POST /run/{runId}/step` with
  `{ mode }`.
- Extension: F10 / F11 / Shift+F11 commands; per-frame breakpoint
  delivery; updated context keys.
- User-visible feature lands here for skills.

### Phase 4 — Variables panel
- Server: emit `frame:scope` on every step boundary.
- Extension: Variables webview view, scope cache keyed by frame id,
  selection wiring with call-stack view.

### Phase 5 — Tool step-into
- Server: `pauseAtNextTool` flag + `tool:awaiting-debugger` event +
  `debugger;` at the dispatcher pause point + ack endpoint.
- Extension: local-server check, `vscode.debug.startDebugging` with a
  Node attach config, in-tool UI overlay, inspector-port setting +
  docs.
- Acceptance: user can hit a breakpoint inside a real tool's
  TypeScript and use the standard VS Code Debug toolbar to step.

## Risks & open questions

- **Source-map fidelity for tools.** If a project's tool TypeScript
  doesn't ship source maps to the place Node loads them from, F11
  inside a tool will pause but on the wrong line. We require
  `sourceMaps: true` in the Node attach config and check at
  feature-doc time that the user's tool build emits maps. If it
  doesn't, the user pauses on the compiled JS — recoverable but
  ugly.
- **Multiple concurrent runs.** Today only one run is in flight at a
  time per editor; the frame model preserves that. The call-stack view
  is scoped to the active run.
- **Inspector port collisions.** If two Steptix sessions run on the
  same machine, only one can hold `--inspect=9229`. The
  `steptix.inspectorPort` setting plus a clear error message
  handles this; out of scope to auto-discover.
- **Breakpoints in unopened skill files.** VS Code holds breakpoints
  for files even when they're not open in an editor, so we don't have
  to pre-open skill files to honour their breakpoints. Verified by
  the `tracker.breakpoints(uri)` implementation
  ([active-file-tracker.ts:159-179](../src/extension/active-file-tracker.ts#L159-L179)) which
  reads from `vscode.debug.breakpoints` directly.
- **Backward compat against older servers.** The extension must
  detect (via the absence of `frame:push` events during a known
  skill-containing run) that the server hasn't been upgraded, and
  surface a one-line "Step Into requires server vN.M+" warning when
  the user hits F11.
- **Step Into on a non-invocation line.** Spec says "fall back to
  step over." Worth a quick UX check that this doesn't surprise users
  who hit F11 by accident on a plain AI step.

## Test plan

- **Unit (runner-core):** event narrowing helpers cover the new
  variants; legacy events still narrow correctly.
- **Unit (extension):** frame-stack reducer (push, pop, scope merge)
  in isolation; arrow-decoration routing across multiple URIs.
- **Integration (server):** running `skill-demo.md` with `stepMode.mode`
  in each value produces the expected pause boundaries; nested skill
  fixture produces the expected push/pop chain.
- **Integration (extension):** mocked server emits a scripted event
  trace; assert the extension's visible state (call stack view,
  variables view, active editor, breakpointStop position) matches at
  each step. Reuse the existing test harness pattern from the
  extension tests.
- **Manual (tool step-into):** run a fixture that calls a real tool
  with the server launched `--inspect`. Verify F11 attaches, pauses,
  stepping works, resume returns control to the Steptix run.
- **Manual (degraded modes):** remote `SERVER_URL` → tool step-into
  errors gracefully; server without `--inspect` → tool step-into
  errors gracefully; older server without frame events → skill step-
  into reports as unsupported.

## Out of scope (followups, not this design)

- Conditional / hit-count breakpoints, including inside skill files.
- Editing variable values from the Variables panel (a real REPL).
- Stepping into AI-driven natural-language steps (e.g. seeing the
  individual page actions an LLM step took).
- "Run to cursor" inside a skill file (the cursor lives in the skill,
  the run is in the test). Doable, but extra UX scaffolding.
- Persisting frame state across a window reload — runs already don't
  survive that.
