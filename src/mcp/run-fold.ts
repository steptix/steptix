/**
 * Turn a run's event stream into the result an agent reads.
 *
 * Almost every rule here exists because the obvious version reports something
 * false. The recurring hazard is that the event stream is a record of what
 * *executed*, while the agent asked about what it *sent* — and server-side
 * skill expansion, inline sections and conditional groups all make those two
 * lists different lengths.
 */
import type { FrameInfo } from '../server/session-manager.js';
import type { RunEvent } from './types.js';

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
  output: string | null;
  error: string | null;
  fromCache: boolean;
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

export interface FoldedRun {
  status: RunStatus;
  streamDropped: boolean;
  steps: FoldedStep[];
  captures: Record<string, string>;
  messages: { level: 'error' | 'warn'; text: string }[];
  warnings: string[];
  /** Present when the `done` event carried it; otherwise the caller polls. */
  reportPath: string | null;
  error: string | null;
  /** Raw base64 PNG of the final failure, if one was requested and small
   *  enough. Prefix already stripped. */
  screenshotBase64: string | null;
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
  includeScreenshot?: boolean;
}

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 500;
/** Generous — captures are meant to be read — but bounded, because the value
 *  originates in the page under test. */
const MAX_CAPTURE_CHARS = 4_000;
/** Above this, an image is more cost than signal — a full-page PNG can run to
 *  several MB of base64, which is real money in image tokens and near some
 *  hosts' payload limits. */
const MAX_SCREENSHOT_BASE64 = 1_500_000;
const DATA_URI_PREFIX = /^data:image\/png;base64,/;

/** Root frames are synthesized by the server whenever expansion ran, so
 *  "has a frame" does NOT mean "came from a skill". And `frame` is absent
 *  entirely when nothing expanded — which §3's "send a dir only if it exists"
 *  rule makes routine, not exotic. Hence both arms. */
function isRootFrame(frame: FrameInfo | undefined): boolean {
  return frame === undefined || (frame.kind === 'test' && frame.id === '');
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
      fromCache: false,
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
  const closeRow = (status: StepStatus, at: number | null): void => {
    if (!open) return;
    open.row.status = status;
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
        open.row.fromCache = event.fromCache ?? false;
        open.row.tab = event.tab ?? open.row.tab;
        // `output: 'skipped'` is how the server reports an `[input:]` or
        // `[interactive]` step it declined to run unattended. Calling that
        // "passed" is a false green on work that never happened.
        const status: StepStatus = event.output === 'skipped' ? 'skipped' : 'passed';
        if (status === 'skipped') sawSkipped = true;
        closeRow(status, at);
        break;
      }

      case 'step:fail': {
        if (!open) open = beginRow(event.line, event.frame, at);
        open.row.error = event.error;
        open.row.tab = event.tab ?? open.row.tab;
        lastFailError = event.error;
        if (event.screenshot) lastFailScreenshot = event.screenshot;
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
        // `reportPath` is spread onto the event by the emitter, which slips
        // past the excess-property check — so it is on the wire even though
        // `RunEvent` does not declare it.
        const maybe = (event as { reportPath?: unknown }).reportPath;
        if (typeof maybe === 'string') reportPath = maybe;
        break;
      }

      default:
        // frame:pop, frame:scope, step:awaiting, tool:awaiting-debugger —
        // debugger protocol, deliberately out of scope here.
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
    warnings.push(
      'The connection to the server ended without a completion event. The run ' +
        'may still be executing there; call get_last_run to check.',
    );
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

  let screenshotBase64: string | null = null;
  if (input.includeScreenshot && lastFailScreenshot) {
    const stripped = lastFailScreenshot.replace(DATA_URI_PREFIX, '');
    if (stripped.length > MAX_SCREENSHOT_BASE64) {
      warnings.push(
        `Failure screenshot dropped: ${Math.round(stripped.length / 1024)}KB of ` +
          'base64 exceeds the size cap.',
      );
    } else {
      screenshotBase64 = stripped;
    }
  }

  return {
    status,
    streamDropped,
    steps,
    captures,
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
  };
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
      fromCache: false,
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
