/**
 * Turn a run's event stream into the result an agent reads.
 *
 * Almost every rule here exists because the obvious version reports something
 * false. The recurring hazard is that the event stream is a record of what
 * *executed*, while the agent asked about what it *sent* — and server-side
 * skill expansion, inline sections and conditional groups all make those two
 * lists different lengths.
 */
// A VALUE import, and the only one in this file that leaves src/mcp — so it
// is on the `steptix mcp` startup path that tests/mcp-entry-graph.test.ts pins.
// Safe: src/utils/secrets.ts reaches parameters.ts, interpolate-env-data.ts,
// data-loader.ts and logger.ts, all of which this process already loads
// through src/mcp/tools.ts, and none of which reaches playwright.
import { redactAuthoredMap, secretValues } from '../utils/secrets.js';
import type { FrameInfo } from '../server/session-manager.js';
import type {
  EffectiveSettings,
  ErrandSummary,
  ErrandTab,
  RunEvent,
  ScreenshotsReturn,
} from './types.js';

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not-run' | 'unknown';
export type RunStatus = 'passed' | 'failed' | 'error' | 'aborted';

export interface FoldedStep {
  index: number;
  sentIndex: number | null;
  line: number;
  uri: string;
  frameKind: 'test' | 'skill' | 'section';
  frameName: string | null;
  text: string | null;
  status: StepStatus;
  /**
   * Why a `skipped` row was skipped — absent on every other status.
   *
   * Three different things arrive as `skipped` and they want different
   * reactions. `'returned'` is an `If … then return` doing exactly what the
   * test asked (stories/step-flow-control.md); `'not-taken'` is the untaken
   * half of a decision or a loop body that ran no passes
   * (stories/control-flow.md); `'unattended'` is an `[input:]` /
   * `[interactive]` step the server declined to run with nobody watching,
   * which needs a human before it can ever pass. Only the last of the three
   * wants anything from the reader — a summary that says "needs a human" over
   * either of the others sends an agent looking for an intervention that was
   * never needed.
   */
  skipCause?: 'returned' | 'not-taken' | 'unattended';
  /**
   * This `failed` row did not stop the run — an `otherwise continue` tail
   * (stories/step-failure-outcomes.md, decision 9).
   *
   * `status` stays `'failed'`, because the step did not do what it said. What the
   * flag buys an agent is the ability to stop treating it as the thing to fix: the
   * run went on, `done.status` already excludes it, and the error on the row is
   * information rather than the cause of a red run.
   *
   * Optional and absent on every other row, the shape `skipCause` uses.
   */
  tolerated?: boolean;
  /**
   * The author's own words for a tolerated failure — the quoted text of
   * `… otherwise continue with warning "…"`, interpolated and masked. Present only
   * beside {@link tolerated}, and only when a warning was written.
   *
   * Beside `error` rather than replacing it, because the two answer different
   * questions: `error` is what went wrong, this is why the author decided it was
   * survivable — the only thing on the row saying the failure was anticipated.
   */
  warning?: string;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  /**
   * Which tab this step ran in, or null when the server did not report one
   * (an older server, or an engine that cannot answer for a target id).
   *
   * Taken from the step's TERMINAL event, not its start: a step that switched
   * tabs is more usefully described by where it ended than where it began,
   * and "which tab did that step actually touch?" is asked after a failure.
   */
  tab: {
    label: string;
    targetId: string | null;
    url: string;
    title: string;
    unexpected: boolean;
  } | null;
}

/**
 * The warning a truncated stream earns, verbatim, so a caller that cannot offer
 * its remedy can drop it by IDENTITY instead of matching its prose.
 *
 * `run_errand` is that caller: `get_last_run` is addressed by `session_id`
 * (`getLastRunInput`), and an errand has no session — so this text names a call
 * the errand's caller cannot make. It substitutes its own remedy in
 * `errandWarnings` (src/mcp/tools.ts), which BOTH its receipt paths run — the
 * truncated one and the finished one, since a stream can die after the `done`
 * frame and still fold with `streamDropped` set. Exported for that filter
 * alone; reword it freely, the filter follows.
 */
export const STREAM_DROPPED_WARNING =
  'The connection to the server ended without a completion event. The run ' +
  'may still be executing there; call get_last_run to check.';

export interface FoldedRun {
  status: RunStatus;
  streamDropped: boolean;
  steps: FoldedStep[];
  /**
   * What the run captured, MASKED — see {@link maskCaptures}. Every other
   * string in this object arrives masked from the server; these did not.
   */
  captures: Record<string, string>;
  messages: { level: 'error' | 'warn'; text: string }[];
  warnings: string[];
  /** Present when the `done` event carried it; otherwise the caller polls. */
  reportPath: string | null;
  error: string | null;
  /** Raw base64 PNG the caller asked for — the failure under `on-failure`, the
   *  last one seen under `final` — if one was available and small enough. Prefix
   *  already stripped. */
  screenshotBase64: string | null;
  /**
   * What the run ran under (stories/run-settings.md §5), or null when the server
   * did not report it.
   *
   * The server half comes off the `done` event; `screenshotsReturn` is added
   * here, because the server never learns it — the return mode is decided
   * entirely on this side of the wire.
   */
  effectiveSettings: FoldedEffectiveSettings | null;
}

/**
 * `EffectiveSettings` plus the return mode, with the server's half nullable.
 *
 * Every server-supplied field is nullable rather than absent so that an older
 * Sessions API server — which omits `effectiveSettings` entirely — still
 * produces a valid result. `screenshotsReturn` is never null: this side always
 * knows it.
 */
export interface FoldedEffectiveSettings {
  model: string | null;
  capture: EffectiveSettings['capture'] | null;
  fullPage: boolean | null;
  sendScreenshots: boolean | null;
  /** stories/run-settings.md §9. Null from a server that predates the switch —
   *  which is a different statement from `'on'`, and worth keeping apart. */
  ai: EffectiveSettings['ai'] | null;
  aiOffReason: EffectiveSettings['aiOffReason'];
  sources: FoldedSettingSources | null;
  screenshotsReturn: ScreenshotsReturn;
}

/**
 * The four sources every server reports, plus the AI one, which only a server
 * carrying §9 does. Its own type rather than `EffectiveSettings['sources']`
 * because the wire spans server versions and that one does not.
 */
export interface FoldedSettingSources {
  model: EffectiveSettings['sources']['model'];
  capture: EffectiveSettings['sources']['capture'];
  fullPage: EffectiveSettings['sources']['fullPage'];
  sendScreenshots: EffectiveSettings['sources']['sendScreenshots'];
  ai: EffectiveSettings['sources']['ai'] | null;
}

/**
 * The server's half of the echo as it ARRIVES — the §§1–8 fields, which every
 * server that reports at all sends, plus the §9 ones, which an older one omits.
 *
 * Kept apart from `EffectiveSettings` on purpose: reusing the server's own type
 * here would force `readEffectiveSettings` to either invent an `ai` value for an
 * older server or reject the whole frame and lose the four fields it did send.
 */
interface WireEffectiveSettings {
  model: string;
  capture: EffectiveSettings['capture'];
  fullPage: boolean;
  sendScreenshots: boolean;
  ai: EffectiveSettings['ai'] | null;
  aiOffReason: EffectiveSettings['aiOffReason'];
  sources: FoldedSettingSources;
}

export interface FoldInput {
  events: RunEvent[];
  /** Arrival time per event, parallel to `events`. Absent in tests that do not
   *  care about timing, in which case durations are reported as null rather
   *  than as a fabricated zero. */
  receivedAt?: number[] | undefined;
  streamDropped: boolean;
  /** Frames the SSE reader could not parse; merged into `warnings`. */
  dropped?: string[];
  sentSteps: string[];
  /** What we put on the wire. Absent when it had to be omitted. */
  sourceLines?: number[] | undefined;
  testFilePath: string;
  /** True when `skillsDir` or `sections` were sent, so the server may have
   *  expanded steps and the sent list is not the executed list. */
  expansionPossible: boolean;
  /**
   * Which screenshot, if any, to return to the caller.
   *
   * Required, and deliberately not defaulted here. `readRunSettings` resolves
   * the tool argument (including `'default'`) against
   * `DEFAULT_SCREENSHOTS_RETURN`, and a second fallback in this file is exactly
   * how two defaults start disagreeing — the fold would keep answering `'none'`
   * long after the product default had moved.
   */
  screenshotsReturn: ScreenshotsReturn;
  /**
   * The project's `desktop.reportScreenshots` (`ProjectContext.desktopScreenshots`).
   *
   * False withholds every screenshot that rode an event marked `surface:
   * 'computer'` — a capture of the whole desktop, not of a page — whatever
   * `screenshotsReturn` asked for (SPEC-use-computer.md §10.1). The server
   * already leaves such a capture off its events when the switch is off; this
   * is the same rule applied where the image would enter the agent's context,
   * so it holds against a server that attached one anyway. A page screenshot
   * is unaffected.
   *
   * Absent reads as the config's own default, `true`: the errand path, which
   * refuses computer mode outright, does not pass it.
   */
  desktopScreenshots?: boolean | undefined;
}

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 500;
/** Generous — captures are meant to be read — but bounded, because the value
 *  originates in the page under test. */
const MAX_CAPTURE_CHARS = 4_000;
/** Above this, an image is more cost than signal — a full-page PNG can run to
 *  several MB of base64, which is real money in image tokens and near some
 *  hosts' payload limits. Exported so the on-demand screenshot
 *  (`get_page_content` with `format: "screenshot"`) is bounded by the same
 *  number: one cap for images leaving this process, wherever they came from. */
export const MAX_SCREENSHOT_BASE64 = 1_500_000;
/** Exported for the same reason. */
export const DATA_URI_PREFIX = /^data:image\/png;base64,/;

/** Root frames are synthesized by the server whenever expansion ran, so
 *  "has a frame" does NOT mean "came from a skill". And `frame` is absent
 *  entirely when nothing expanded — which §3's "send a dir only if it exists"
 *  rule makes routine, not exotic. Hence both arms. */
function isRootFrame(frame: FrameInfo | undefined): boolean {
  return frame === undefined || (frame.kind === 'test' && frame.id === '');
}

/**
 * The captures, masked — the one place in this fold where that has to happen
 * here rather than having happened already.
 *
 * Every other string a folded run carries is text the SERVER wrote and
 * masked on its way out: a step's line, an error, an `output` message. A
 * `capture` event is different by design — it exists so the Steptix
 * Variables panel can hold the real value and reveal it on request, so the
 * server sends it raw and each client decides. The MCP client had no such
 * decision: `captures{}` went into `run_test_file` / `run_steps` /
 * `run_errand`'s result verbatim, so a `[store as: password]` reached the
 * agent — and the agent's transcript — in clear (review 6, finding 4).
 *
 * {@link redactAuthoredMap} is the rule, not `redactMap`: a capture's name is
 * the AUTHOR's word end to end (`[store as: …]`, `[output: …]`, a tool's
 * output alias), so the whole name goes to `isSecretName` and a dotted one is
 * not split at the dot. Nothing in this map is a loop's pass binding — the
 * server emits one `capture` per NAMED capture, not per property.
 *
 * The free-text set is built from the captures themselves, which is all this
 * process has: it never sees the run's `## Parameters`, its `.env` or its
 * data files. That is enough for the leak that matters here — a secret-named
 * capture spelled out inside a LATER capture's record — and it is the same
 * `secretValues` rule the runner applies to the same kind of map, rather than
 * a second opinion about what a secret is. Values the server already masked
 * arrive as `***` and contribute nothing.
 */
function maskCaptures(captures: Record<string, string>): Record<string, string> {
  return redactAuthoredMap(captures, secretValues(captures));
}

interface OpenRow {
  row: FoldedStep;
  /** null when the caller supplied no arrival times, so a duration is
   *  reported as unknown rather than invented. */
  startedAt: number | null;
}

export function foldRun(input: FoldInput): FoldedRun {
  const {
    events,
    streamDropped,
    sentSteps,
    sourceLines,
    testFilePath,
    expansionPossible,
  } = input;

  const frames = new Map<string, FrameInfo>();
  const executed: FoldedStep[] = [];
  const captures: Record<string, string> = {};
  const messages: { level: 'error' | 'warn'; text: string }[] = [];
  const warnings: string[] = [...(input.dropped ?? [])];

  let open: OpenRow | undefined;
  let doneStatus: RunStatus | undefined;
  let reportPath: string | null = null;
  let lastFailError: string | null = null;
  let lastOutputError: string | null = null;
  let lastFailScreenshot: string | null = null;
  /** The most recent screenshot on ANY terminal event — what `final` returns.
   *  A passing step carries one only when per-action capture is on, which is
   *  what makes `final` depend on the capture setting. */
  let lastScreenshot: string | null = null;
  /** `desktop.reportScreenshots: false` — see `FoldInput.desktopScreenshots`. */
  const withholdDesktop = input.desktopScreenshots === false;
  /** The last run-ending failure was a computer-mode step — the one case where
   *  a missing `on-failure` screenshot is the privacy switch's doing, not the
   *  capture setting's. */
  let lastFailOnComputer = false;
  /** The most recent terminal event that decides `final` was a computer-mode
   *  step under the privacy switch, so its capture was withheld — here, or by
   *  the server before sending — the same question for `final`. */
  let lastShotWithheld = false;
  let sawFailure = false;
  let serverSettings: WireEffectiveSettings | null = null;
  let sawSkipped = false;

  /** Sent-array position for a line the server reported, or null. */
  const sentIndexForLine = (line: number): number | null => {
    if (sourceLines) {
      const idx = sourceLines.indexOf(line);
      return idx === -1 ? null : idx;
    }
    // Without `sourceLines` the server falls back to its own step index, which
    // counts *expanded* steps — so it only maps back to what we sent when
    // nothing could have expanded.
    if (expansionPossible) return null;
    const idx = line - 1;
    return idx >= 0 && idx < sentSteps.length ? idx : null;
  };

  /** Walk `parentId` to the outermost frame, whose `line` is the invocation
   *  site in the file we sent — the only link an expanded step has back to
   *  the step the agent wrote. */
  const outermost = (frame: FrameInfo): { frame: FrameInfo; complete: boolean } => {
    let current = frame;
    const guard = new Set<string>([current.id]);
    while (current.parentId !== null && current.parentId !== '') {
      const parent = frames.get(current.parentId);
      // A parent we never saw means a `frame:push` was dropped. Stopping here
      // and using this frame's `line` would read a line number from inside a
      // skill body as though it were an invocation line in the test file —
      // attributing the step to whatever sent step happens to sit on that
      // line, and suppressing that step's own row. Report incompleteness
      // instead and let the caller decline to guess.
      if (!parent || guard.has(parent.id)) return { frame: current, complete: false };
      guard.add(parent.id);
      current = parent;
    }
    return { frame: current, complete: true };
  };

  const beginRow = (line: number, frame: FrameInfo | undefined, at: number | null): OpenRow => {
    const root = isRootFrame(frame);
    let sentIndex: number | null;
    let text: string | null;
    let uri: string;
    let frameKind: 'test' | 'skill' | 'section';
    let frameName: string | null;

    if (root) {
      sentIndex = sentIndexForLine(line);
      text = sentIndex === null ? null : (sentSteps[sentIndex] ?? null);
      uri = frame?.uri ?? testFilePath;
      frameKind = 'test';
      frameName = null;
    } else {
      const top = outermost(frame!);
      // The invocation line lives on the outermost frame; the step's own
      // `line` points into the skill or section body, a file the agent never
      // sent us and whose text we therefore cannot show.
      sentIndex = top.complete ? sentIndexForLine(top.frame.line) : null;
      text = null;
      uri = frame!.uri;
      frameKind = frame!.kind;
      frameName = frame!.skillName ?? null;
    }

    const row: FoldedStep = {
      index: 0, // assigned after the merge
      sentIndex,
      line,
      uri,
      frameKind,
      frameName,
      text,
      status: 'unknown',
      output: null,
      error: null,
      durationMs: null,
      tab: null,
    };
    return { row, startedAt: at };
  };

  /**
   * `at` is the timestamp of the terminal event, or null when there wasn't
   * one (the stream dropped, or a new step started while this one was still
   * open). A duration is only meaningful between a start and its own
   * terminal — measuring to "whenever we gave up" would report a number that
   * looks like a step time and isn't.
   */
  const closeRow = (
    status: StepStatus,
    at: number | null,
    skipCause?: FoldedStep['skipCause'],
  ): void => {
    if (!open) return;
    open.row.status = status;
    if (skipCause) open.row.skipCause = skipCause;
    open.row.durationMs =
      at === null || open.startedAt === null ? null : at - open.startedAt;
    executed.push(open.row);
    open = undefined;
  };

  for (const [position, event] of events.entries()) {
    // Sampled at arrival, never here: this loop runs after the stream has
    // closed, so `Date.now()` would be the same instant for every event and
    // every step would report a duration of zero.
    const at = input.receivedAt?.[position] ?? null;
    switch (event.type) {
      case 'frame:push':
        frames.set(event.frame.id, event.frame);
        break;

      case 'step:start':
        // A start with a row still open means we never saw its terminal —
        // record it as unknown rather than losing it.
        if (open) closeRow('unknown', null);
        open = beginRow(event.line, event.frame, at);
        // Seeded from the start event so a step whose stream drops before its
        // terminal still reports the tab it was running in. Overwritten by
        // the terminal event when one arrives.
        open.row.tab = event.tab ?? null;
        break;

      case 'step:pass': {
        if (!open) open = beginRow(event.line, event.frame, at);
        open.row.output = event.output ?? null;
        open.row.tab = event.tab ?? open.row.tab;
        if (withholdDesktop && event.surface === 'computer') {
          // Withheld, and not an earlier picture left standing in its place:
          // `final` would hand that back as how the run left the screen.
          //
          // Whether or not the event carried one — a current server strips it
          // before sending, so acting only on a screenshot-bearing event left
          // the page shot from BEFORE the excursion as `final`, with no
          // warning. The step:fail branch below does the same.
          lastShotWithheld = true;
          lastScreenshot = null;
        } else if (event.screenshot) {
          lastShotWithheld = false;
          lastScreenshot = event.screenshot;
        }
        // `output: 'skipped'` is how the server reports a step that never ran
        // on the older of the two conventions. Calling that "passed" is a
        // false green on work that never happened.
        //
        // TWO producers ride it, and they want opposite reactions. `skipKind`
        // is how they are told apart — machine-readable on purpose, because
        // deriving it from the reason's prose would break the moment either
        // sentence was reworded:
        //
        //  - `'unattended'` — an `[input:]` / `[interactive]` step the server
        //    declined to run with nobody watching. It needs a person, which is
        //    what `sawSkipped` goes on to warn about.
        //  - `'not-taken'` — the untaken half of a decision, or a loop body
        //    that ran no passes. The test did what it was told; warning here
        //    sends an agent looking for an intervention nothing asked for.
        //
        // Absent means `'unattended'`: until the field existed that was the
        // only producer of this event, so that is what an older server means
        // by saying nothing.
        const status: StepStatus = event.output === 'skipped' ? 'skipped' : 'passed';
        const skipCause = event.skipKind === 'not-taken' ? 'not-taken' : 'unattended';
        if (status === 'skipped') {
          if (event.reason) open.row.output = event.reason;
          if (skipCause === 'unattended') sawSkipped = true;
        }
        closeRow(status, at, status === 'skipped' ? skipCause : undefined);
        break;
      }

      case 'step:skip': {
        // A step an `If … then return` left behind
        // (stories/step-flow-control.md, decision 9). It never STARTED — no
        // `step:start`, no frame push — so there is no open row to close;
        // begin one and close it in the same breath.
        //
        // Closed with a null terminal timestamp deliberately: a duration is
        // only meaningful between a start and its own terminal, and reporting
        // 0 ms here would read as "ran, instantly" rather than "did not run".
        if (open) closeRow('unknown', null);
        open = beginRow(event.line, event.frame, at);
        open.row.output = event.reason;
        // `sawSkipped` is NOT set. That flag drives the "these steps need a
        // human" warning, which belongs to `[input:]` / `[interactive]` steps
        // the server declined to run unattended. A return is the test doing
        // exactly what it was told, so a warning here would send an agent
        // looking for an intervention that was never needed. The cause is
        // recorded on the row instead, so the one-line summary can word the
        // two apart rather than guessing at one of them.
        closeRow('skipped', null, 'returned');
        break;
      }

      case 'step:fail': {
        if (!open) open = beginRow(event.line, event.frame, at);
        // The two outcome booleans, read off the FRAME rather than the type. Wire
        // data, both additive (stories/step-failure-outcomes.md, decision 9): a
        // server that predates them sends neither and the fold keeps working —
        // the posture `readEffectiveSettings` takes below.
        const outcome = event as {
          deliberate?: boolean;
          tolerated?: boolean;
          warning?: string;
        };
        // Fold the code-behind story into the one error string the summary
        // carries: the entry failing itself, or — codeBehindStale — the entry
        // throwing and the AI attempt failing too, where `event.error` alone
        // would silently drop the crash that started it.
        //
        // A DELIBERATE failure is exempt from all of that and carries the author's
        // sentence verbatim (decision 2). `step.fail()` throws the class a failed
        // `step.expect` throws, so a compiled one arrives with `fromCodeBehind`
        // set — and "Code-behind failed: The variable value was peanuts" reads as
        // a broken entry over a message working exactly as written.
        const error = outcome.deliberate === true
          ? event.error
          : event.codeBehindStale
          ? `${event.error} (its code-behind threw first: ${event.codeBehindStale.error})`
          : event.fromCodeBehind
            ? `Code-behind failed: ${event.error}`
            : event.error;
        open.row.error = error;
        open.row.tab = event.tab ?? open.row.tab;
        // A TOLERATED failure is recorded on the row and stops there (decision 9).
        // It must not become `lastFailError` — the run's `error` field, the one
        // sentence an agent reads as "this is why the run is not green" — nor set
        // `sawFailure`, which the missing-screenshot advice keys on: naming it as
        // the run's error sends an agent to fix a step the author said to carry on
        // from.
        if (outcome.tolerated === true) {
          open.row.tolerated = true;
          // The author's sentence, when they wrote one. It travels on the event and
          // nowhere else, so a fold that drops it loses it for good.
          if (outcome.warning !== undefined) open.row.warning = outcome.warning;
        } else {
          lastFailError = error;
          sawFailure = true;
          lastFailOnComputer = event.surface === 'computer';
          // A computer-mode failure under the privacy switch returns nothing —
          // and not an earlier failure's page screenshot in its place, which
          // an agent would read as a picture OF this failure. Whether or not
          // the server attached one: a current server does not.
          if (withholdDesktop && lastFailOnComputer) lastFailScreenshot = null;
        }
        if (withholdDesktop && event.surface === 'computer') {
          // Tolerated or not, and with or without a screenshot on the event:
          // neither `final` nor `on-failure` may fall back to an earlier
          // picture — the page as it looked before the excursion, or an
          // earlier failure's — as if it were this one.
          lastShotWithheld = true;
          lastFailScreenshot = null;
          lastScreenshot = null;
        } else if (event.screenshot) {
          lastShotWithheld = false;
          lastFailScreenshot = event.screenshot;
          lastScreenshot = event.screenshot;
        }
        closeRow('failed', at);
        break;
      }

      case 'capture':
        // Last write wins: a name captured twice in one run is the later
        // value by the time the run ends, which is what a subsequent step saw.
        //
        // Capped like `messages[]` and the screenshot are. A capture's value
        // comes from the page under test, so it is the one field whose size
        // and wording are chosen by whoever controls that page — uncapped it
        // is a free channel into the agent's context.
        captures[event.name] =
          event.value.length > MAX_CAPTURE_CHARS
            ? `${event.value.slice(0, MAX_CAPTURE_CHARS)}… (truncated)`
            : event.value;
        break;

      case 'output':
        if (event.kind === 'error' || event.kind === 'warn') {
          if (event.kind === 'error') lastOutputError = event.msg;
          messages.push({
            level: event.kind,
            text: event.msg.slice(0, MAX_MESSAGE_CHARS),
          });
        }
        break;

      case 'done': {
        doneStatus = event.status;
        // Both fields are declared on the event and both are still checked at
        // runtime, because this is wire data: an older server omits
        // `effectiveSettings` altogether, and a malformed frame must degrade to
        // "not reported" rather than to a shape the output schema will reject.
        const maybe = (event as { reportPath?: unknown }).reportPath;
        if (typeof maybe === 'string') reportPath = maybe;
        serverSettings = readEffectiveSettings(event.effectiveSettings);
        break;
      }

      default:
        // frame:pop, frame:scope, step:awaiting, tool:awaiting-debugger,
        // codebehind:awaiting-debugger — debugger protocol, deliberately
        // out of scope here.
        break;
    }
  }

  if (open) closeRow('unknown', null);

  const status: RunStatus = streamDropped ? 'error' : (doneStatus ?? 'error');

  const steps = mergeSyntheticRows({
    executed,
    sentSteps,
    sourceLines,
    testFilePath,
    status,
    streamDropped,
  });
  steps.forEach((row, i) => {
    row.index = i;
  });

  if (steps.some((s) => s.status === 'unknown')) {
    warnings.push(
      'Some steps could not be attributed individually. Conditional steps and ' +
        'skills with an empty body produce no per-step events, so their outcome ' +
        'is not visible here — the overall run status still applies.',
    );
  }
  if (sawSkipped) {
    warnings.push(
      'One or more steps were skipped because they need a human ' +
        '(`[input:]` / `[interactive]`). They did not run.',
    );
  }
  if (streamDropped) {
    warnings.push(STREAM_DROPPED_WARNING);
  }
  if (doneStatus === 'aborted') {
    // Not expected: the only abort source is our own disconnect, and a client
    // that disconnected does not read the events that follow. Seeing one means
    // something aborted the run that was not this call.
    warnings.push(
      'The server reported the run as aborted, which this client did not ' +
        'request — something else stopped it (a server shutdown, or another ' +
        'client closing the session).',
    );
  }

  const screenshotsReturn = input.screenshotsReturn;
  let screenshotBase64: string | null = null;
  if (screenshotsReturn !== 'none') {
    const wanted = screenshotsReturn === 'final' ? lastScreenshot : lastFailScreenshot;
    if (wanted) {
      const stripped = wanted.replace(DATA_URI_PREFIX, '');
      if (stripped.length > MAX_SCREENSHOT_BASE64) {
        // The run result matters more than the picture, so the image is dropped
        // and the run stands. Expect this more often with `fullPage` on — a
        // full-page PNG of a long page runs to several MB of base64.
        warnings.push(
          `Screenshot dropped: ${Math.round(stripped.length / 1024)}KB of base64 ` +
            'exceeds the size cap. Turn off fullPage, or read the report instead.',
        );
      } else {
        screenshotBase64 = stripped;
      }
    } else if (
      withholdDesktop &&
      (screenshotsReturn === 'final' ? lastShotWithheld || lastFailOnComputer : lastFailOnComputer)
    ) {
      // The one missing screenshot that is nobody's capture setting: the step
      // ran on the computer surface, where the picture is the whole desktop,
      // and the project said to keep those out. Advising `capture` here would
      // send the caller to change a setting that cannot bring it back.
      warnings.push(
        'No screenshot returned: the step ran in computer mode, where a screenshot is of the ' +
          "whole desktop, and desktop.reportScreenshots is false in this project's steptix.config.json.",
      );
    } else {
      // Nothing to return, and the cause is almost always the capture setting
      // rather than anything about this run: a passing step carries no
      // screenshot unless per-action capture is on, and a failing one carries
      // none when failure capture is off. Naming that beats an empty result the
      // caller has to diagnose.
      const explain = missingScreenshotReason(screenshotsReturn, sawFailure, serverSettings);
      if (explain) warnings.push(explain);
    }
  }

  return {
    status,
    streamDropped,
    steps,
    // Masked HERE rather than at the `capture` case, so the free-text set is
    // built from the whole run: a password captured at step 2 is hidden
    // inside a record captured at step 7, which a per-event pass could not
    // see yet.
    captures: maskCaptures(captures),
    messages: messages.slice(-MAX_MESSAGES),
    warnings,
    reportPath,
    // A passing run has no error, whatever went wrong along the way.
    //
    // The runner retries a failed action, and each attempt emits an `output`
    // of kind `error` — so a run that recovered and passed still leaves error
    // text in the stream. Surfacing it here produced results reading
    // `status: "passed"` next to `error: "Action failed [wait]: Timeout..."`,
    // which invites an agent to "fix" something that already worked. The
    // transient text is still in `messages[]` for anyone who wants it.
    error: status === 'passed' ? null : (lastFailError ?? lastOutputError),
    screenshotBase64,
    effectiveSettings: {
      model: serverSettings?.model ?? null,
      capture: serverSettings?.capture ?? null,
      fullPage: serverSettings?.fullPage ?? null,
      sendScreenshots: serverSettings?.sendScreenshots ?? null,
      ai: serverSettings?.ai ?? null,
      aiOffReason: serverSettings?.aiOffReason ?? null,
      sources: serverSettings?.sources ?? null,
      screenshotsReturn,
    },
  };
}

/** Sources, validated as a set so a partial one degrades to "not reported"
 *  rather than to an object the output schema rejects. `ai` is read separately
 *  and nullable: an older server sends the other four and not this one, and
 *  rejecting the set over it would throw away what it did send. */
function readSources(value: unknown): FoldedSettingSources | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const valid = new Set(['server', 'project', 'session']);
  const out: Record<string, string | null> = {};
  for (const key of ['model', 'capture', 'fullPage', 'sendScreenshots']) {
    const from = record[key];
    if (typeof from !== 'string' || !valid.has(from)) return null;
    out[key] = from;
  }
  out.ai = typeof record.ai === 'string' && valid.has(record.ai) ? record.ai : null;
  return out as unknown as FoldedSettingSources;
}

/**
 * Read the server's `effectiveSettings` off a `done` frame.
 *
 * Field-by-field rather than cast-and-hope: an older server omits this
 * entirely, and a mismatch anywhere has to read as "the server did not report
 * it" — the alternative is a `structuredContent` validation failure that strips
 * the whole run result at the very end of a run that worked.
 */
function readEffectiveSettings(value: unknown): WireEffectiveSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const captureModes = new Set(['every-step', 'on-failure', 'none', 'custom']);
  if (typeof record.model !== 'string') return null;
  if (typeof record.capture !== 'string' || !captureModes.has(record.capture)) return null;
  if (typeof record.fullPage !== 'boolean') return null;
  if (typeof record.sendScreenshots !== 'boolean') return null;
  const sources = readSources(record.sources);
  if (!sources) return null;
  // The §9 pair is read permissively, not required: a server that predates the
  // AI switch omits both, and rejecting the frame over them would report a
  // perfectly good run as having no settings at all.
  const ai = record.ai === 'on' || record.ai === 'off' ? record.ai : null;
  const reason =
    ai === 'off' && (record.aiOffReason === 'policy' || record.aiOffReason === 'no-key')
      ? record.aiOffReason
      : null;
  return {
    model: record.model,
    capture: record.capture as EffectiveSettings['capture'],
    fullPage: record.fullPage,
    sendScreenshots: record.sendScreenshots,
    ai,
    aiOffReason: reason,
    sources,
  };
}

/**
 * The errand's own accounting, off the `done` frame (stories/errands.md
 * §Return).
 *
 * Separate from `foldRun` rather than a field on it: the fold is shared with
 * the two session run tools, and an errand block on their results would be a
 * key that is always null. The receipt is `foldRun`'s output plus this.
 *
 * Validated field by field for the same reason `readEffectiveSettings` is —
 * this is wire data, and a malformed block must read as "no errand" (which the
 * tool reports as an attach failure) rather than reach an output schema that
 * rejects it after the errand has already driven someone's tab.
 *
 * Returns null when no `done` frame carried one, which is what an errand that
 * never attached looks like.
 */
export function readErrandSummary(events: readonly RunEvent[]): ErrandSummary | null {
  const done = events.find((event) => event.type === 'done');
  if (!done || done.type !== 'done') return null;
  const value = done.errand as unknown;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.errandId !== 'string' || record.errandId === '') return null;
  if (typeof record.root !== 'string') return null;
  if (record.scope !== 'project' && record.scope !== 'user') return null;
  const openedTabs = readErrandTabs(record.openedTabs);
  const keptOpen = readErrandTabs(record.keptOpen);
  if (openedTabs === null || keptOpen === null) return null;
  return {
    errandId: record.errandId,
    root: record.root,
    scope: record.scope,
    // The two page reads the detach path is allowed to fail at: a tab that
    // went away under us still produces a receipt, with these empty.
    finalUrl: typeof record.finalUrl === 'string' ? record.finalUrl : '',
    finalTitle: typeof record.finalTitle === 'string' ? record.finalTitle : '',
    openedTabs,
    keptOpen,
  };
}

/** One tab list off the wire, or null when it is not one. A tab whose
 *  `targetId` never resolved simply omits the key — the url and title still
 *  identify it — so it is read as optional rather than required. */
function readErrandTabs(value: unknown): ErrandTab[] | null {
  if (!Array.isArray(value)) return null;
  const tabs: ErrandTab[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    tabs.push({
      ...(typeof record.targetId === 'string' && { targetId: record.targetId }),
      url: typeof record.url === 'string' ? record.url : '',
      title: typeof record.title === 'string' ? record.title : '',
    });
  }
  return tabs;
}

/**
 * Why the requested screenshot is not here — naming the setting to change.
 *
 * Returns null when there is nothing useful to say: asking for the failure shot
 * on a run that never failed is not a problem, it is the happy path.
 */
function missingScreenshotReason(
  mode: Exclude<ScreenshotsReturn, 'none'>,
  sawFailure: boolean,
  settings: WireEffectiveSettings | null,
): string | null {
  const capture = settings?.capture;
  const captureSays =
    capture === undefined
      ? ''
      : ` This run's capture setting was "${capture}".`;

  if (mode === 'on-failure') {
    if (!sawFailure) return null;
    return (
      'No failure screenshot was available, because nothing captured one. Pass ' +
      `capture: "on-failure" (or "every-step") to photograph failures.${captureSays}`
    );
  }
  // 'final'
  return (
    'No screenshot was available to return. A passing step is only photographed ' +
    'when capture is "every-step", so pass that alongside screenshots_return: ' +
    `"final" — or use get_page_content with format: "screenshot" to photograph the page now.${captureSays}`
  );
}

/**
 * Add rows for sent steps that produced no events at all, and interleave them
 * with the executed rows.
 *
 * The status choice here is the one that most needs getting right. Conditional
 * groups emit nothing — no start, no terminal — and consume several sent
 * indices including the group's continuation step. So "the run finished and I
 * saw no event for this step" cannot mean "it did not run": on a passing run
 * it almost certainly did. `unknown` is the honest default; `not-run` is only
 * claimed where there is positive evidence the run stopped early and never
 * reached the step.
 */
function mergeSyntheticRows(args: {
  executed: FoldedStep[];
  sentSteps: string[];
  sourceLines: number[] | undefined;
  testFilePath: string;
  status: RunStatus;
  streamDropped: boolean;
}): FoldedStep[] {
  const { executed, sentSteps, sourceLines, testFilePath, status, streamDropped } = args;

  // Without `sourceLines` there is no position to place a synthetic row at,
  // and no way to know which sent step it would represent.
  if (!sourceLines) return [...executed];

  const accounted = new Set<number>();
  for (const row of executed) {
    if (row.sentIndex !== null) accounted.add(row.sentIndex);
  }

  // Forward-filled anchors, so a row whose own sentIndex is unknown still
  // sorts after the last one that was known.
  const anchors: (number | null)[] = [];
  let running: number | null = null;
  for (const row of executed) {
    if (row.sentIndex !== null) running = row.sentIndex;
    anchors.push(running);
  }
  // The LAST row's own index, not the forward-filled one. When the last thing
  // that executed cannot be attributed to a sent step, "did the run get past
  // step N?" has no answer — and borrowing an earlier row's index would answer
  // it confidently and wrongly, claiming `not-run` for steps that may well
  // have run.
  const lastAnchor = executed.at(-1)?.sentIndex ?? null;

  const runStoppedEarly =
    !streamDropped && (status === 'failed' || status === 'error' || status === 'aborted');

  const result = [...executed];

  for (let sentIndex = sentSteps.length - 1; sentIndex >= 0; sentIndex--) {
    if (accounted.has(sentIndex)) continue;

    // "After the last terminal event" is only decidable when we know where
    // the last executed step sat in the sent array.
    const isAfterLastExecuted = lastAnchor !== null && sentIndex > lastAnchor;
    const stepStatus: StepStatus =
      runStoppedEarly && isAfterLastExecuted ? 'not-run' : 'unknown';

    const row: FoldedStep = {
      index: 0,
      sentIndex,
      line: sourceLines[sentIndex] ?? sentIndex + 1,
      uri: testFilePath,
      frameKind: 'test',
      frameName: null,
      text: sentSteps[sentIndex] ?? null,
      status: stepStatus,
      output: null,
      error: null,
      durationMs: null,
      tab: null,
    };

    // Place it after the last executed row that belongs to an earlier or
    // equal sent position, so the array still reads in run order.
    let insertAt = 0;
    for (let i = result.length - 1; i >= 0; i--) {
      const anchor = i < anchors.length ? anchors[i] : undefined;
      if (anchor !== undefined && anchor !== null && anchor <= sentIndex) {
        insertAt = i + 1;
        break;
      }
    }
    result.splice(insertAt, 0, row);
    anchors.splice(insertAt, 0, sentIndex);
  }

  return result;
}
