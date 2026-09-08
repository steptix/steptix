/**
 * Typed message protocol between the extension host and the webview.
 *
 * Both directions are exhaustive discriminated unions. Use the narrowing
 * helpers below at message-handler boundaries — never compare `type`
 * strings inline.
 */

import type { ErrorPayload } from './errors.js';

// ---------------------------------------------------------------------------
// Server-side run events (mirrored from SSE)
// ---------------------------------------------------------------------------

export type RunStatus = 'passed' | 'failed' | 'error' | 'aborted';
/**
 * `'skipped'` is additive (stories/step-flow-control.md, decision 9): a step an
 * `If … then return` left behind DID NOT RUN, and calling that `passed` is a
 * green report for work that never happened — the failure direction this
 * codebase treats as the worst. The union widens rather than being re-encoded
 * as a boolean beside it, so the compiler finds every consumer that switches
 * on a step status.
 */
export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped';

/**
 * Origin frame for a step event. Present from servers that support the
 * step-into protocol (added in Phase 1 of the step-into work). Absent on
 * legacy servers — clients must tolerate missing `frame`.
 *
 * A frame is one execution scope: the top-level test, a `[skill: ...]`
 * invocation, or an inline `### Section` call. Frames nest when skills call
 * skills, when a section calls a section, and in either combination. `id` is
 * unique per run and stable for the lifetime of the frame; `parentId` is null
 * for the test frame and the parent's id otherwise.
 *
 * A runtime loop's tail (`While …`, `Repeat … until …`, `For each …`) gets a
 * FRESH id on every pass — the frame's lifetime is the pass — so a client that
 * keys on `id` sees one frame per pass, not one per loop. The shape of the id
 * is the server's business and must not be parsed; `iteration` is what says
 * which pass this is (stories/control-flow.md §"Painting, frames and the
 * report").
 */
export interface FrameInfo {
  id: string;
  parentId: string | null;
  kind: 'test' | 'skill' | 'section';
  /**
   * Absolute **filesystem path** of the file this frame's steps live in —
   * despite the field's name, NOT a `file://` URI. Every producer passes a
   * plain path (`skill.filePath`, `ctx.sectionsFilePath`, the synthesised
   * test frame's `request.testFilePath`). A client turning it into a URI
   * must use the equivalent of `Uri.file`, never `Uri.parse`, which reads a
   * Windows drive letter as a scheme.
   *
   * For `kind === 'section'` that is the file that **defines** the section:
   * the test file for a test-file section, the skill file for one declared
   * inside a skill body.
   */
  uri: string;
  /** 1-based line of the step in that file. */
  line: number;
  /**
   * Set when `kind === 'skill'` — the skill name as authored — and when
   * `kind === 'section'`, where it carries the **section** name. For a
   * section declared inside a skill, the enclosing skill's name is on the
   * nearest ancestor frame with `kind === 'skill'`, not here.
   */
  skillName?: string;
  /**
   * 1-based position, in the section's own data table, of the row this frame
   * is running — present only on a looped section's frames
   * (stories/data-driven-rows.md part B). The server has stamped this on
   * every such frame since part B landed (`src/skills/expander.ts` writes it,
   * `src/server/session-manager.ts` copies it onto the wire frame); it is
   * declared here so the client can *read* it.
   *
   * It is the table position, not the loop index: a run that narrows the
   * section to rows 2 and 3 still reports `iteration: 2` then `3`, so the
   * frame, the Output banner, the report badge and the gutter all name the
   * same row (stories/data-row-progress-and-selection.md, decision 1).
   */
  iteration?: number;
  /**
   * How many iterations there are in total — the `(2/3)` badge's denominator.
   *
   * Sent alongside `iteration`, never on its own, and **not always sent with
   * it**: a table's rows are counted before the first one runs, but a runtime
   * loop (`While …`, `Repeat … until …`) stops when the page says so, and its
   * frames are pushed mid-loop with no total to give
   * (stories/control-flow.md §"Painting, frames and the report"). Render `?`
   * for the denominator when it is absent — `Go to the next page (3/?)` —
   * rather than treating the frame as unlooped.
   */
  iterationCount?: number;
}

export interface StepStartEvent {
  type: 'step:start';
  /** 1-based source line of the step in the original document. */
  line: number;
  /** Origin frame the step belongs to. Optional for backward compat. */
  frame?: FrameInfo;
}

export interface StepPassEvent {
  type: 'step:pass';
  line: number;
  /** Optional captured output (e.g. AI explanation). */
  output?: string;
  /** data:image/png;base64 URI, may be empty. */
  screenshot?: string;
  frame?: FrameInfo;
  /** True when every AI turn for this step was served from `StepCache` —
   *  no AI call was made. Absent / false means the AI was called. The
   *  client uses this to paint a ⚡ glyph instead of the standard ✓ and
   *  to mark the run-log line as `(cached)`. */
  fromCache?: boolean;
  /**
   * True when the step ran its code-behind entry instead of calling the AI
   * (stories/codebehind-compile.md §What the author sees). Painted with the code mark, logged
   * `(code-behind)`. Distinct from `fromCache`: that one replays a recorded AI
   * transcript, this one runs TypeScript the author can read.
   */
  fromCodeBehind?: boolean;
  /**
   * Present when the step's entry threw and the step then passed under AI.
   * Painted ⚠ — "ran under AI; recompile" — and `file` is what Open
   * Code-behind opens. On a pass event because the STEP passed; it is the
   * entry that failed.
   */
  codeBehindStale?: { file: string; error: string };
}

export interface StepFailEvent {
  type: 'step:fail';
  line: number;
  error: string;
  screenshot?: string;
  frame?: FrameInfo;
  /**
   * True when the failure came from the step's own code-behind entry — a
   * failed `step.expect`, or the entry throwing under strict replay. Tells
   * the client to present `error` as "the code-behind failed", not as an
   * AI-run failure.
   */
  fromCodeBehind?: boolean;
  /**
   * Present when the step's entry threw, the step fell through to AI, and
   * the AI attempt then failed too. `error` above is the AI failure; this is
   * the code crash that put the step on that path — without it the client
   * could only report the second failure of the two.
   */
  codeBehindStale?: { file: string; error: string };
}

/**
 * A step that never ran because an earlier step ended the flow it was in
 * (stories/step-flow-control.md, decision 9).
 *
 * One per skipped step line, plus one per skipped nested CALL line — a
 * `### Section` or `[skill: ...]` invocation inside the returned body,
 * addressed by that frame's `invocationLine` in its PARENT frame's file. The
 * call line is what the author sees in the editor and has no step of its own in
 * the expansion, so without an event of its own it would keep whatever glyph
 * the gutter last painted on it.
 *
 * Deliberately NOT a `step:start` + terminal pair. A skipped step is never
 * started: nothing settles, nothing is captured, no frame is pushed for it. A
 * client that pairs starts with terminals therefore sees a `step:skip` for a
 * line it never saw start, which is exactly the shape of what happened.
 *
 * `reason` is the same sentence the step's `results[]` row carries — `Not run:
 * step 3 returned from "Sign in"` — built by one formatter
 * (`skippedByReturnReason`, src/runner/flow-control.ts) so the wire and the
 * report cannot describe one skip in two different ways.
 */
export interface StepSkipEvent {
  type: 'step:skip';
  /** 1-based source line, in `frame`'s file, of the step (or call) not run. */
  line: number;
  /**
   * The frame the line belongs to. For a skipped step that is the step's own
   * frame; for a skipped nested call line it is the frame the CALL is written
   * in — the parent — because that is the file the line lives in.
   *
   * No `frame:push` is emitted for a skipped step, so this may name a frame the
   * client never saw pushed. That is the point: a nested call inside a returned
   * body must not push and pop clean, or its call line would paint ✓ for work
   * that never ran.
   */
  frame?: FrameInfo;
  reason: string;
}

/**
 * Emitted when execution enters a new frame — i.e. just before the first
 * step of a `[skill: ...]` invocation runs. Pairs 1:1 with a `frame:pop`.
 */
export interface FramePushEvent {
  type: 'frame:push';
  frame: FrameInfo;
}

/**
 * Emitted when a frame finishes (its last step passed, or execution fell
 * off the end of the skill body). `outputs` carries the values the skill
 * exposed back to the caller — aliased into the caller's variable scope.
 */
export interface FramePopEvent {
  type: 'frame:pop';
  frameId: string;
  outputs: Record<string, string>;
}

/**
 * Snapshot of the variable scope visible inside a frame at a step boundary.
 * Used by the Variables panel (Phase 4) — Phase 1 servers may emit these
 * sparsely or not at all; clients must treat the type as informational.
 */
export interface FrameScopeEvent {
  type: 'frame:scope';
  frameId: string;
  scope: Record<string, string>;
}

export interface OutputEvent {
  type: 'output';
  msg: string;
  kind: 'info' | 'warn' | 'error';
}

/**
 * Emitted whenever a step gives a variable a value. Lets the webview update
 * the Variables panel live as that happens.
 */
export interface CaptureEvent {
  type: 'capture';
  line: number;
  name: string;
  value: string;
  /**
   * Where this variable came from. Three values flow through this event:
   * `'capture'` (an `[output:]`/`[store as:]` extraction from the page),
   * `'toolOutput'` (a `[tool:]`/`[skill:]` return) and `'assignment'` (a
   * `Set {{name}} to "…"` step — stories/variable-assignment.md).
   * `'parameter'` values arrive via the separate `parametersResolved` event,
   * which already tags them by event type, so it is intentionally absent
   * here. Required on new emitters; consumers talking to a not-yet-upgraded
   * server must treat an absent — or unrecognised — `source` as `'capture'`
   * (the conservative default, and what makes adding this third value safe).
   */
  source: 'capture' | 'toolOutput' | 'assignment';
}

export interface DoneEvent {
  type: 'done';
  status: RunStatus;
  /** Absolute path of the HTML report written by the server when report
   *  generation succeeded. Omitted when the run produced no step results
   *  or `generateReport` threw. Clients use this to surface an "Open
   *  Report" button after the run finishes. Backward-compatible: older
   *  servers omit the field, older clients ignore it. */
  reportPath?: string;
  /**
   * How many steps healed under AI because their code-behind entry threw,
   * and what those AI turns cost
   * (stories/codebehind-selector-ambiguity.md §"A healed run stops reporting
   * as a clean pass").
   *
   * Absent when nothing healed, so a clean run says nothing new. `status` is
   * deliberately unaffected — a healed run still passed, and the whole point
   * is that the COST is what was invisible, not the outcome. Clients use it
   * to name the recurring price of leaving an entry broken: those tokens are
   * paid again on every subsequent run until the step is repaired.
   *
   * Backward-compatible in both directions: older servers omit the field,
   * older clients ignore it.
   */
  healed?: { steps: number; tokens: number };
}

/**
 * Step-mode controls available on requests and resume commands. The runner
 * uses these to decide whether to pause between steps, and at what depth:
 *
 *  - `continue` — run to the next breakpoint or end-of-batch. No
 *    between-step pauses.
 *  - `into` — pause unconditionally after each emitted step. Stepping
 *    "into" a `[skill: ...]` happens naturally: the next step the server
 *    pauses on is the first step of the skill body.
 *  - `over` — pause when the next step is at or shallower than the
 *    just-executed step's frame depth. Skips the entire body of any
 *    deeper skill invocation as a single atomic step.
 *  - `out` — pause when the next step is strictly shallower than the
 *    just-executed step's frame depth. Runs to the end of the current
 *    frame. No-op at the test (root) frame.
 */
export type StepMode = 'continue' | 'into' | 'over' | 'out';

/**
 * Emitted by step-mode-aware servers when they reach a pause point
 * between steps. `line` and `frame` point at the next step that will
 * execute when the client sends the next run-control command. Acts as
 * the "yellow ▶" signal for the step-into UI; mirrors how
 * `breakpointStop` signals the pause at a breakpoint hit.
 *
 * Servers that don't support stepMode never emit this; legacy clients
 * that don't read it stay on the existing breakpoint-only pause story.
 */
export interface StepAwaitingEvent {
  type: 'step:awaiting';
  line: number;
  frame?: FrameInfo;
}

/**
 * Emitted right before the server hits its `debugger;` pause at the tool
 * dispatcher's call site (Phase 5 — tool step-into). The client takes this
 * as its cue to attach VS Code's Node debugger to the server process and
 * then POST `/sessions/:id/tool-debugger-ack` so the server proceeds.
 *
 * Only fires when the client opted into tool step-into via
 * `pauseAtNextTool` on the next-run-control. Servers that don't support
 * tool step-into never emit this; clients that don't read it stay on the
 * existing pause-between-steps story.
 */
export interface ToolAwaitingDebuggerEvent {
  type: 'tool:awaiting-debugger';
  /** The tool name as authored on the `[tool: ...]` line. */
  toolName: string;
  /** Absolute path to the tool's source file (`.ts` from the catalogue's
   *  `RegisteredTool.filePath`). The extension uses this to scope the
   *  Node debugger's source-map handling and to surface "we're stepping
   *  into <file>" in the UI overlay. */
  toolFilePath?: string;
  /** 1-based source line of the `[tool: ...]` invocation in the test/skill
   *  file. The yellow ▶ stays parked on this line while VS Code's Node
   *  debugger drives the user inside the tool body. */
  line: number;
  /** Origin frame the tool call belongs to. */
  frame?: FrameInfo;
}

/**
 * Emitted right before the server hits its `debugger;` pause at a step's
 * code-behind entry (stories/codebehind-debugging.md). Same contract as
 * `tool:awaiting-debugger`, one seam over: the client attaches VS Code's
 * Node debugger and then POSTs `/sessions/:id/tool-debugger-ack` (the ack
 * route is shared — it means "a debugger is attached, proceed", which is
 * not tool-specific).
 *
 * Only fires when the client opted in via `pauseAtNextCodeBehind` AND the
 * next step actually has a bound entry — a step with no code-behind
 * consumes the flag silently, so F11 degrades to a plain step pause.
 */
export interface CodeBehindAwaitingDebuggerEvent {
  type: 'codebehind:awaiting-debugger';
  /** Absolute path of the `.steps.ts` whose entry is about to run. */
  file: string;
  /** 1-based source line of the step in its test/skill file. The yellow ▶
   *  stays parked here while the Node debugger drives the entry body. */
  line: number;
  /** Origin frame the step belongs to. */
  frame?: FrameInfo;
}

export type RunEvent =
  | StepStartEvent
  | StepPassEvent
  | StepFailEvent
  | StepSkipEvent
  | OutputEvent
  | CaptureEvent
  | DoneEvent
  | FramePushEvent
  | FramePopEvent
  | FrameScopeEvent
  | StepAwaitingEvent
  | ToolAwaitingDebuggerEvent
  | CodeBehindAwaitingDebuggerEvent
  // A compile-mode run's own frames (stories/compile-as-you-go.md §On the
  // wire). Deliberately the SAME shapes the compile stream carries, so a
  // client's folding code works on either stream: `compile:step` as each
  // entry is generated or declined, `compile:result` once, terminal, just
  // before `done`. Absent from an ordinary run, which sends no `compile`.
  | CompileStepEvent
  | CompileProgressEvent
  | CompileResultEvent;

// ---------------------------------------------------------------------------
// Compile stream (stories/codebehind-compile.md §Server)
// ---------------------------------------------------------------------------

/**
 * The compile pipeline's phases, in order.
 *
 * Mirrors `CompilePhase` in the framework's `src/codebehind/compile.ts`. Named
 * again here because `runner-core` is the wire contract and must not import
 * from the server it talks to.
 */
export type CompilePhase =
  | 'record'
  | 'select'
  | 'generate'
  | 'review'
  | 'replay'
  | 'repair'
  | 'write';

/**
 * `partial` (stories/codebehind-compile-as-a-run.md §Write what passed): the
 * compile proposes what it has — proven entries, write-offs, entries no round
 * reached — and the summary says which is which. `failed` proposes nothing.
 */
export type CompileStatus = 'green' | 'partial' | 'failed';

/** A phase started, or reported its result. */
export interface CompilePhaseEvent {
  type: 'compile:phase';
  phase: CompilePhase;
  /** 1-based replay round, when the phase repeats. */
  round?: number;
  message: string;
}

/** Something happened to one step, 1-based. */
export interface CompileStepEvent {
  type: 'compile:step';
  phase: CompilePhase;
  step: number;
  /** The step's source line in the test file, when the server knows it —
   *  paint ▶ there while the model works on the step. */
  line?: number;
  message: string;
}

/**
 * How far the compile tail has got (stories/compile-tail-progress.md).
 *
 * The numbers a client needs, as numbers. The prose on `compile:step` is for
 * reading; deriving "5 of 8" by matching those message strings would be a
 * mirror of the server's wording that rots the first time the wording changes,
 * so the counts ride their own frame and the prose is never parsed.
 *
 * Emitted when a generation starts, when one finishes, when Review starts, and
 * once — with the final `total` — the moment the run's last step ends.
 */
export interface CompileProgressEvent {
  type: 'compile:progress';
  /**
   * Entries that have reached a terminal state: generated, kept as AI, or
   * errored — the summary's own decomposition. A stop counts its skipped
   * entries here too: they will never finish, and the alternative is a bar
   * frozen at "5 of 8" until the result frame takes it away.
   */
  done: number;
  /** Entries enqueued so far. Final once the run's last step has ended. */
  total: number;
  phase: 'generate' | 'review';
  /** 1-based step being generated right now, when `phase` is `'generate'`. */
  step?: number;
  /** That step's source line, for a client that wants to reveal it. */
  line?: number;
  /** A Review pass is still owed. Never set in `'steps'` mode, which runs
   *  none by design. */
  reviewPending?: boolean;
  /**
   * This is the frame emitted the moment the run's last step ended — the
   * client's cue that everything from here on is tail.
   *
   * A client cannot tell that from the counts: a mid-run frame and the run-end
   * frame can carry the same `done`/`total`, and the alternative is matching
   * the forecast's prose, which is the mirror this event exists to avoid. The
   * strip is gated on it, so it stays absent while the steps are still
   * painting — during the run the steps ARE the progress.
   */
  runEnded?: boolean;
}

/**
 * One event of a run the compile drove — Record, or a Replay round — untouched
 * inside the wrapper (stories/codebehind-compile-as-a-run.md §Every run is on
 * the stream). A client folds `event` as it folds a run's own: ▶ on
 * `step:start`, the code mark on a `step:pass` with `fromCodeBehind`, ✗ with the error
 * and screenshot on `step:fail`.
 */
export interface CompileRunEvent {
  type: 'compile:run';
  phase: 'record' | 'replay';
  /** 1-based replay round. */
  round?: number;
  event: RunEvent;
}

/** Terminal narrative event. The result follows separately. */
export interface CompileDoneEvent {
  type: 'compile:done';
  status: CompileStatus;
  message: string;
}

export interface CompileSummary {
  /** Absolute path of the test file. */
  test: string;
  totalSteps: number;
  /** Steps whose entries this pass generated. */
  compiled: number;
  /** Steps whose existing entries were kept verbatim. */
  kept: number;
  /** Steps that stay AI — existing `ai: true` entries plus new declines. */
  keptAi: number;
  rounds: number;
  tokensUsed: number;
  /** Absolute paths written. Always empty from the server, which never writes
   *  under the project — the client applies. */
  written: string[];
  /** Where the candidate was left when nothing was written. */
  candidatePath?: string;
  /** Why the compile is not green. */
  error?: string;
  /** Steps (1-based) whose new entries no replay round executed to a pass.
   *  Proposed as code all the same; the next run proves or flags them. */
  unproven: number[];
  /** Steps (1-based) written off as `ai: true` after a replay failure. */
  writtenOffAi: number[];
  /** Where the recording stopped, when it did not reach the end of the test —
   *  the compile was then a prefix compile of the steps before it. */
  stoppedAt?: { step: number; error: string };
  /** Selected steps the prefix never reached; nothing was generated for them. */
  notAttempted: number[];
  /** Where the recording, the candidate and any replay failure were written —
   *  the test's `.aiui-codebehind-cache/<name>.recording/`
   *  (stories/codebehind-recording-on-disk.md). */
  recordingDir: string;
  /**
   * Steps whose parameter was recovered by matching a recorded literal to
   * its value because the model did not name the placeholder in the action
   * (stories/placeholder-preserving-actions.md, decision 6). The compliance
   * signal for that story; absent from older servers.
   */
  recoveredByValue?: Array<{ step: number; name: string }>;
}

/**
 * The last frame of a compile stream: what to diff, and what to say about it.
 *
 * `files` is the whole proposed content of each `.steps.ts`, not a patch — the
 * client renders it as the right-hand side of a diff and writes it on Apply.
 * Several files when the test invokes skills, whose entries compile into the
 * skill's own file.
 */
export interface CompileResultEvent {
  type: 'compile:result';
  status: CompileStatus;
  files: Record<string, string>;
  summary: CompileSummary;
}

export type CompileEvent =
  | CompilePhaseEvent
  | CompileStepEvent
  | CompileProgressEvent
  | CompileDoneEvent
  | CompileResultEvent
  | CompileRunEvent
  | OutputEvent;

export function isCompileEvent(value: unknown): value is CompileEvent {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'compile:phase' ||
    t === 'compile:step' ||
    t === 'compile:progress' ||
    t === 'compile:done' ||
    t === 'compile:result' ||
    (t === 'compile:run' && isRunEvent((value as { event?: unknown }).event)) ||
    t === 'output'
  );
}

/** `POST /codebehind/compile` (stories/codebehind-compile.md §Server). */
export interface CompileRequest {
  /** Absolute path of the test file to compile. */
  testFilePath: string;
  /** The editor's steps, for the server's saved-file guard. */
  steps?: string[];
  sections?: Record<string, { name: string; headingLine: number; steps: string[]; stepLines: number[] }>;
  envName?: string;
  /**
   * The caller's session — the one this test runs in. Record runs in it and
   * leaves it open, as a Run would; every compile records, to disk beside the
   * test (stories/codebehind-recording-on-disk.md).
   */
  sessionId?: string;
  select?: { onlyStale?: boolean; all?: boolean; steps?: number[] };
  maxRounds?: number;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Per-document state snapshot (sent host → webview)
// ---------------------------------------------------------------------------

/**
 * Why a step line wears a ✗ (or a ⚠) — the failure text, pinned to the line
 * so every surface that paints the mark can also say what went wrong. Shapes
 * mirror the `step:fail` / `step:pass` wire fields they are captured from.
 *
 * Both error strings are CLIPPED at capture (`clipFailureText`), not at
 * render: this struct is held per line for the session, persisted into
 * `.testbench/run-state.json`, and re-posted to the webview on every snapshot
 * — including the ones a bare cursor move emits. A Playwright call log runs to
 * kilobytes, and no surface shows more than the clip. The untruncated text
 * stays in the run log, the report, and the server's own logs.
 */
export interface StepFailureDetail {
  /** The step's own failure message. Absent on a ⚠ line — the step passed;
   *  it is the entry that failed. */
  error?: string;
  /** The failure in `error` came from the step's code-behind (a failed
   *  `step.expect`, or the entry throwing under strict replay). */
  fromCodeBehind?: boolean;
  /** The code-behind crash, when the entry threw and the step fell through
   *  to AI: the whole story of a ⚠, the first half of a ✗ whose AI attempt
   *  then failed too. */
  codeBehindStale?: { file: string; error: string };
}

/**
 * A step's failure with its code-behind context folded in — the one sentence
 * every single-line surface prints: the run log, the compile fold, the panel's
 * Output log, and Test Explorer's failure message.
 *
 * One function because the wording is user-facing and was drifting: the same
 * event was rendered "(code-behind) X" in one place and "Code-behind failed:
 * X" in another. Structured surfaces that legitimately show more — the editor
 * hovers and the panel's inline step row — build their own multi-line text
 * from the same `StepFailureDetail` fields.
 */
export function describeStepFailure(failure: StepFailureDetail): string {
  const error = failure.error ?? 'Step failed';
  // The stale case names BOTH: `error` is the AI failure that followed, and
  // dropping the crash would hide the reason the step ran under AI at all.
  if (failure.codeBehindStale) {
    return `${error} (its code-behind threw first: ${failure.codeBehindStale.error})`;
  }
  if (failure.fromCodeBehind) return `${error} (in its code-behind)`;
  return error;
}

/**
 * Did this `step:pass` report a step that never ran?
 *
 * The wire has no third verdict, so a step the run decided against — the
 * untaken half of a chain, the body of a `While` that never entered, an
 * `[input:]` the server cannot prompt for inside a section body — arrives as a
 * PASS carrying `output: 'skipped'` (stories/control-flow.md). Every surface
 * that derives a glyph or a log line from `step:pass` has to ask this first,
 * and three of the six used not to: the compile gutter painted the untaken
 * branch green, and two log lines claimed a ✓ for a step that did nothing.
 *
 * One predicate rather than six copies of `ev.output === 'skipped'`, so a
 * seventh consumer is a grep away from the rule instead of from the string.
 */
export function isSkippedPass(event: { output?: string }): boolean {
  return event.output === 'skipped';
}

/** How much of one error string a `StepFailureDetail` keeps. Comfortably more
 *  than any hover or panel row shows, so the clip is invisible in practice. */
export const MAX_FAILURE_TEXT_CHARS = 2000;

/** Clip one error string for storage in a `StepFailureDetail`. */
export function clipFailureText(text: string): string {
  return text.length > MAX_FAILURE_TEXT_CHARS
    ? `${text.slice(0, MAX_FAILURE_TEXT_CHARS)}… (truncated — see the run log)`
    : text;
}

/**
 * Build the pinned detail for a `step:fail` / `step:pass` event, clipping both
 * error strings. The one place a detail is constructed, so every surface that
 * pins one gets the same bounds and the same field rules.
 */
export function stepFailureDetail(event: {
  error?: string;
  fromCodeBehind?: boolean;
  codeBehindStale?: { file: string; error: string };
}): StepFailureDetail {
  return {
    ...(event.error !== undefined && { error: clipFailureText(event.error) }),
    ...(event.fromCodeBehind && { fromCodeBehind: true }),
    ...(event.codeBehindStale && {
      codeBehindStale: {
        file: event.codeBehindStale.file,
        error: clipFailureText(event.codeBehindStale.error),
      },
    }),
  };
}

/**
 * Mirror of the active TextEditor's TestBench state: file text, breakpoints,
 * statuses, paused-at marker. The webview renders against this; the host is
 * the source of truth.
 */
export interface FileStateSnapshot {
  uri: string | null;
  filePath: string | null;
  isTestFile: boolean;
  text: string;
  breakpoints: number[];
  statuses: Array<
    [
      number,
      | 'running'
      | 'pass'
      | 'pass-cached'
      /** Passed by running its code-behind entry — the `</>` code mark. */
      | 'pass-code-behind'
      /** Passed under AI after its entry threw — ⚠, recompile. */
      | 'pass-stale'
      | 'fail'
      | 'skip'
      | 'stopped',
    ]
  >;
  errors: Array<[number, ErrorPayload]>;
  /** Per-line failure text for ✗ and ⚠ statuses — same keying as `statuses`. */
  failures: Array<[number, StepFailureDetail]>;
  breakpointStop: number | null;
  selectedLines: number[];
  cursorLine: number;
}

// ---------------------------------------------------------------------------
// Host → webview
// ---------------------------------------------------------------------------

/**
 * Whenever the active TextEditor changes, or the breakpoint/status/cursor
 * state on the active file changes, the host posts a fresh snapshot. The
 * webview re-renders against it.
 */
export interface HostActiveFileMsg {
  type: 'activeFile';
  snapshot: FileStateSnapshot;
}

export interface HostRunEventMsg {
  type: 'runEvent';
  event: RunEvent;
  /**
   * The document this event belongs to (`vscode.Uri.toString()`), stamped by
   * the host's per-controller post callback.
   *
   * The panel follows the active editor but every controller posts to the same
   * webview, so without this the panel's Output section is one shared pane
   * that shows whichever test spoke last (stories/compile-tail-progress.md
   * §The panel log). Optional only so a host that predates the field — or a
   * test double that posts by hand — still type-checks; the webview falls back
   * to the active file.
   */
  uri?: string;
}

export interface HostRunErrorMsg {
  type: 'runError';
  payload: ErrorPayload;
}

/**
 * Ask the user to type something. `mode: 'input'` is one-shot (filling a
 * `[input: var]` slot) and is now handled host-side via showInputBox. The
 * webview only sees `mode: 'interactive'` for the multi-turn REPL composer.
 */
export interface HostPromptMsg {
  type: 'prompt';
  mode: 'input' | 'interactive';
  message: string;
  /** For mode === 'input', the {{var}} this answer fills. */
  varName?: string;
}

/** Tell the webview to hide its composer — the prompt cycle is over. */
export interface HostPromptDoneMsg {
  type: 'promptDone';
}

/**
 * Resolved `## Parameters` map. Sent at run start once the host has loaded
 * .env and substituted `$VAR` references — lets the Variables panel show
 * real values instead of the raw `$VAR` placeholders the webview parsed
 * from the source. Secret-named entries (password / token / apikey...)
 * are still masked at render time by the existing maskIfSecret helper.
 */
export interface HostParametersResolvedMsg {
  type: 'parametersResolved';
  values: Record<string, string>;
}

/**
 * The worst status each line reached across a data-driven run's rows, sent
 * once when the loop ends (stories/data-driven-rows.md, part A).
 *
 * A line that failed on any row must stay red — a green gutter after a red row
 * is a lie — but each row repaints the same lines, so the last clean row would
 * otherwise erase the evidence. Deliberately NOT a `runEvent`: run events also
 * reach the Test Explorer's listener, which renders each `step:fail` as a test
 * message, so replaying them would double-count every failure there while
 * fixing the gutter.
 */
export interface HostRowSummaryMsg {
  type: 'rowSummary';
  /** The test document these lines belong to, as a string URI. */
  uri: string;
  /** One entry per line that failed on at least one row. */
  failures: Array<{ line: number; rows: number[] }>;
}

/** How a data row of a table ended. The report's words, so the panel, the
 *  gutter and the HTML report cannot describe the same row differently
 *  (stories/data-row-progress-and-selection.md, decision 8). */
export type DataRowStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'stopped'
  | 'skipped';

/**
 * Host → webview: the live matrix — every data table in the active file and
 * each row's state (stories/data-row-progress-and-selection.md §The Rows
 * section in the Runner panel).
 *
 * Posted when a run starts (every row `pending`), at each row and iteration
 * boundary, and at run end. It carries what the report's matrix carries, so
 * the panel and the report cannot disagree.
 *
 * The extension host reads it too: `applyToTracker` paints each row's `line`
 * with the status cell the step vocabulary already has, which is why the
 * message names the editor line as well as the table position. One message,
 * one source of truth for both surfaces.
 */
export interface HostRowsMsg {
  type: 'rows';
  /** The test document, as a string URI. */
  uri: string;
  tables: Array<{
    /** 'run' for the table under `## Steps`; otherwise the section name as
     *  authored. */
    table: 'run' | { section: string };
    /** 1-based line of the table's header row. */
    headerLine: number;
    rows: Array<{
      /** 1-based table position — stable across a narrowed run. */
      row: number;
      /** 1-based editor line the row occupies. */
      line: number;
      /** `"k=v, k=v"` with secrets masked — the SAME text as the Output
       *  banner (`maskIfSecret`). */
      values: string;
      status: DataRowStatus;
      /** `"failed at step 6"` | `"not run (stopped)"` | `"not run (paused)"` |
       *  `"not run (iteration 2 failed)"`. The panel's trailing note. */
      detail?: string;
      durationMs?: number;
      /**
       * Gutter hover for this row's mark — the long form of `detail`: a
       * failed row's `Row 3 failed at step 6 — "<step text>"` plus the error
       * and the row's values, or a skipped row's reason with the Run This Row
       * hint. Absent on a passed row, which has no hover, exactly as a passed
       * step has none.
       *
       * Read by the extension host only; the panel shows `detail`.
       */
      hover?: string;
    }>;
  }>;
}

/** True while a run is in flight; lets the webview enable/disable buttons. */
export interface HostRunningMsg {
  type: 'running';
  running: boolean;
  /**
   * This is the ACTIVE DOCUMENT's run state being re-synced after an editor
   * switch, not a run starting or ending.
   *
   * The panel resets its runtime variables on the leading edge of `running`
   * — a new run must not inherit the last one's values — and looking at a
   * different, already-running test is not a new run. Without this flag,
   * switching to a running test would wipe the variables it had collected.
   */
  sync?: boolean;
}

/**
 * Mark the line where a run paused at a breakpoint. `null` clears the
 * pause indicator. The webview/decorations show a yellow ▶ glyph on the
 * paused line.
 */
export interface HostBreakpointStopMsg {
  type: 'breakpointStop';
  line: number | null;
  /**
   * Set only when `line` is a section-body line **and** the host knows how to
   * resume from it — i.e. it also knows the invocation that body is running
   * under (`callLine`), or knows there isn't one because the body was run
   * detached (`callLine: null`).
   *
   * Its absence on a body line is meaningful, not a default: it marks a
   * marker we cannot resume — one left behind by a dropped stream or a
   * restarted server — which Continue must refuse rather than guess at. See
   * testbench-native/stories/specs/sections-run-and-resume.md §5.1.
   *
   * The webview ignores this field; only the tracker reads it.
   */
  resumeContext?: { kind: 'section-body'; callLine: number | null };
}

/**
 * Surface multi-test batch run progress in the sidebar webview. The webview
 * renders a banner at the top while `state` is non-null and clears it on
 * `null`. The Test Explorer's progress UI is still the primary surface;
 * this banner exists so users staring at the TestBench sidebar know a
 * batch is in flight and don't try to drive runs from this panel.
 */
export interface HostBatchBannerMsg {
  type: 'batchBanner';
  state: { running: number; total: number } | null;
}

/**
 * Offer (or withdraw) the "re-run this skill step with its variables" action
 * in the Variables panel. Sent with a non-null `failure` when a step inside a
 * top-level skill fails and its session is still live; the webview shows the
 * captured scope with editable capture rows and a "Re-run from failed step"
 * button. `failure: null` withdraws it. The webview also withdraws it on the
 * next `running: true` (a new run invalidates the parked failure's scope).
 */
export interface HostSkillRerunAvailableMsg {
  type: 'skillRerunAvailable';
  failure: {
    /** Owning test document URI (as a string). Echoed back in the re-run
     *  message so the host targets THIS test's controller — critical when two
     *  tests share a skill and both have a parked failure. */
    testUri: string;
    /** Skill name, for the panel heading. */
    skillName: string;
    /** Captured scope to seed, already stripped of `__skill*` internals. */
    scope: Record<string, string>;
    /** Names within `scope` that are the skill's input parameters — read-only
     *  in v1 (baked into step text at expansion). Everything else is an
     *  editable captured/runtime var. */
    paramNames: string[];
  } | null;
}

/** One already-formatted compile log line, for the panel to append. */
export interface HostCompileEventMsg {
  type: 'compileEvent';
  line: string;
  /** The document this line belongs to — see `HostRunEventMsg.uri`. */
  uri?: string;
}

/**
 * The compile tail's status strip for one file
 * (stories/compile-tail-progress.md §The panel strip).
 *
 * `state: null` takes the strip down. The strip is deliberately file-scoped:
 * a panel showing github.md with securebank.md's counts on it reads as the
 * wrong file's state, and it has no coherent answer for two compiles at once.
 * The workbench-global signals — the notification and the status bar item —
 * are what cover the author who has navigated away.
 */
export interface HostCompileProgressMsg {
  type: 'compileProgress';
  /** The document whose compile this describes — see `HostRunEventMsg.uri`. */
  uri?: string;
  state: CompileStripState | null;
}

/** What the strip draws. */
export interface CompileStripState {
  /** Basename of the test being compiled. */
  file: string;
  /**
   * Entries finished, and entries enqueued. Both null until a
   * `compile:progress` frame arrives — which an older server never sends, and
   * which is why the strip has an indeterminate form at all.
   */
  done: number | null;
  total: number | null;
  phase: 'generate' | 'review';
  /** 1-based step being generated right now. */
  step?: number;
  /** That step's line in the test file. */
  line?: number;
  /** A review pass still follows the generation queue. */
  reviewPending?: boolean;
}

/**
 * One event of a run the compile drove — the Record, or a Replay round —
 * forwarded for the panel's Variables section (captures) and mirrored to the
 * gutter by the host (stories/codebehind-compile-as-a-run.md §Every run is on
 * the stream). The log line for it arrives separately as `compileEvent`, so
 * the panel does not log this one.
 */
export interface HostCompileRunEventMsg {
  type: 'compileRunEvent';
  phase: 'record' | 'replay';
  round?: number;
  event: RunEvent;
}

export type HostToWebviewMsg =
  | HostActiveFileMsg
  | HostRunEventMsg
  | HostRunErrorMsg
  | HostPromptMsg
  | HostPromptDoneMsg
  | HostParametersResolvedMsg
  | HostRowSummaryMsg
  | HostRowsMsg
  | HostRunningMsg
  | HostBreakpointStopMsg
  | HostBatchBannerMsg
  | HostSkillRerunAvailableMsg
  | HostCompileEventMsg
  | HostCompileProgressMsg
  | HostCompileRunEventMsg;

// ---------------------------------------------------------------------------
// Webview → host
// ---------------------------------------------------------------------------

export interface WebviewReadyMsg {
  type: 'ready';
}

export interface WebviewRunMsg {
  type: 'run';
  /**
   * 1-based line numbers to run. Empty array runs everything from the
   * cursor onwards (the host expands as needed).
   */
  lines: number[];
}

export interface WebviewRunAllMsg {
  type: 'runAll';
}

export interface WebviewStopMsg {
  type: 'stop';
}

export interface WebviewRestartSessionMsg {
  type: 'restartSession';
}

/** User submitted text into the composer. Newlines preserved as-is. */
export interface WebviewPromptResponseMsg {
  type: 'promptResponse';
  text: string;
}

/** User clicked Cancel (or hit Stop while a prompt was open). */
export interface WebviewPromptCancelMsg {
  type: 'promptCancel';
}

/** User clicked a line in the sidebar's step list — focus the active editor. */
export interface WebviewRevealLineMsg {
  type: 'revealLine';
  line: number;
}

/** User clicked the breakpoint dot in the sidebar — toggle on the active file. */
export interface WebviewToggleBreakpointMsg {
  type: 'toggleBreakpoint';
  line: number;
}

/** User clicked Resume — re-run from the breakpoint pause line. */
export interface WebviewResumeMsg {
  type: 'resume';
}

/** User clicked Pause — abort current stream, mark resume point. */
export interface WebviewPauseMsg {
  type: 'pause';
}

/**
 * User clicked the batch-banner's "Open Test Results" link. Host
 * forwards to the built-in `workbench.panel.testResults.focus` command.
 * A dedicated message rather than arbitrary command execution keeps the
 * webview → host surface narrow.
 */
export interface WebviewFocusTestResultsMsg {
  type: 'focusTestResults';
}

/**
 * User picked "Clear status here" on a step's context menu. Drops the
 * pass/fail status and any error attached to that single line — the
 * file-wide `testbench.clearStatuses` command remains for clearing all.
 */
export interface WebviewClearStatusMsg {
  type: 'clearStatus';
  line: number;
}

/**
 * Diagnostic readback from the webview to the host. The webview posts
 * this whenever its internal `runtimeVariables` map changes (i.e. when
 * a `frame:scope` / `capture` / `parametersResolved` event updates it).
 * Used only by the test hooks — production code reads the same state
 * from the controller's per-frame scope map. Posted unconditionally so
 * a test harness doesn't have to drive the webview's request/response
 * cycle.
 */
export interface WebviewStateMsg {
  type: 'webviewState';
  runtimeVariables: Record<string, string>;
}

/**
 * User clicked "Re-run from failed step" in the Variables panel. `edits` are
 * the (caller-visible) captured-var values the user changed; the host overlays
 * them on the captured scope and re-runs the failed skill from the failed step
 * to the end of the skill on the live session. Param / `__skill*` names are
 * never included (params are read-only in v1; internals aren't editable).
 */
export interface WebviewRerunSkillStepMsg {
  type: 'rerunSkillStep';
  /** Owning test document URI (echoed from `skillRerunAvailable`) so the host
   *  re-runs the right test when more than one has a parked failure. */
  testUri: string;
  edits: Record<string, string>;
}

/**
 * User pressed Compile in the runner panel. The host always compiles against
 * the document's own session — from its last run when that can be the
 * recording, recording in it otherwise (stories/codebehind-compile-as-a-run.md).
 */
export interface WebviewCompileMsg {
  type: 'compile';
}

/**
 * Webview → host: run the chosen rows (and optionally chosen step lines).
 *
 * The selection narrows every axis, and an axis with nothing selected means
 * all of it (stories/data-row-progress-and-selection.md, decision 3): no
 * `rows` means every run row, no `lines` means every step.
 */
export interface WebviewRunRowsMsg {
  type: 'runRows';
  /** Run-table rows, 1-based table positions, ascending. */
  rows?: number[];
  /** Section name as authored → 1-based table positions, ascending. */
  sectionRows?: Record<string, number[]>;
  /** Selected step lines, if any. */
  lines?: number[];
  /**
   * Every row of ONE table — the ▷ Run all rows button — named as the table
   * rather than as the numbers the panel happens to be showing.
   *
   * Same reasoning as `rerunFailedRows`: the panel's list came from a `rows`
   * message that can be a run old, so a table that has since gained a row
   * would run all but the new one. The host resolves the set from the file as
   * it is now. When present it replaces `rows`/`sectionRows`, which the panel
   * does not send alongside it.
   */
  all?: 'run' | { section: string };
}

/**
 * Webview → host: re-run the rows one table left red.
 *
 * The panel does NOT send the numbers it is showing. Its `rows` message can be
 * a run old, and re-running a stale number would run a row the author has
 * since edited into a different one — so the button names the TABLE and the
 * host resolves the set from the file as it is now, through the same
 * `failedRowsToRerun` the palette command uses.
 */
export interface WebviewRerunFailedRowsMsg {
  type: 'rerunFailedRows';
  /** 'run' for the table under `## Steps`; otherwise the section name as
   *  authored. */
  table: 'run' | { section: string };
}

export type WebviewToHostMsg =
  | WebviewCompileMsg
  | WebviewReadyMsg
  | WebviewRunMsg
  | WebviewRunRowsMsg
  | WebviewRerunFailedRowsMsg
  | WebviewRunAllMsg
  | WebviewStopMsg
  | WebviewRestartSessionMsg
  | WebviewPromptResponseMsg
  | WebviewPromptCancelMsg
  | WebviewRevealLineMsg
  | WebviewToggleBreakpointMsg
  | WebviewResumeMsg
  | WebviewPauseMsg
  | WebviewFocusTestResultsMsg
  | WebviewClearStatusMsg
  | WebviewStateMsg
  | WebviewRerunSkillStepMsg;

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function isHostMsg(value: unknown): value is HostToWebviewMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'activeFile' ||
    t === 'runEvent' ||
    t === 'runError' ||
    t === 'prompt' ||
    t === 'promptDone' ||
    t === 'parametersResolved' ||
    // The two data-row messages. `rowSummary` was missing here from the day
    // it was added — nothing in the extension host routes host messages
    // through this guard, so the omission was invisible; it is listed now so
    // a future consumer that does guard cannot silently drop the repaint.
    t === 'rowSummary' ||
    t === 'rows' ||
    t === 'running' ||
    t === 'breakpointStop' ||
    t === 'batchBanner' ||
    t === 'skillRerunAvailable' ||
    t === 'compileEvent' ||
    t === 'compileProgress' ||
    t === 'compileRunEvent'
  );
}

export function isWebviewMsg(value: unknown): value is WebviewToHostMsg {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'ready' ||
    t === 'run' ||
    t === 'runRows' ||
    t === 'rerunFailedRows' ||
    t === 'runAll' ||
    t === 'stop' ||
    t === 'restartSession' ||
    t === 'promptResponse' ||
    t === 'promptCancel' ||
    t === 'revealLine' ||
    t === 'toggleBreakpoint' ||
    t === 'resume' ||
    t === 'pause' ||
    t === 'focusTestResults' ||
    t === 'clearStatus' ||
    t === 'webviewState' ||
    t === 'rerunSkillStep' ||
    t === 'compile'
  );
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'step:start' ||
    t === 'step:pass' ||
    t === 'step:fail' ||
    // A step an `If … then return` left behind (stories/step-flow-control.md).
    t === 'step:skip' ||
    t === 'output' ||
    t === 'capture' ||
    t === 'done' ||
    t === 'frame:push' ||
    t === 'frame:pop' ||
    t === 'frame:scope' ||
    t === 'step:awaiting' ||
    t === 'tool:awaiting-debugger' ||
    t === 'codebehind:awaiting-debugger' ||
    // Only a compile-mode run emits these; an ordinary one never does.
    t === 'compile:step' ||
    t === 'compile:progress' ||
    t === 'compile:result'
  );
}
