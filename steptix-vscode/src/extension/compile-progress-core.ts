/**
 * The pure half of the compile-tail signals (stories/compile-tail-progress.md).
 *
 * Text and shape only — no `vscode`, so the wording rules can be tested with
 * `node --test` rather than only inside an Electron harness. The stateful
 * halves (`CompileTailStatusBar`, the run controller's strip) import these.
 */

/** One compile tail, as the aggregator and the strip both see it. */
export interface CompileTail {
  /** Basename of the test being compiled — what every surface names it by. */
  file: string;
  /** Entries finished / enqueued. Null until a `compile:progress` frame lands,
   *  which an older server never sends. */
  done: number | null;
  total: number | null;
  phase: 'generate' | 'review';
  /** 1-based step being generated right now. */
  step?: number | undefined;
  line?: number | undefined;
  /** A review pass still follows the queue. */
  reviewPending?: boolean | undefined;
}

/**
 * "5 of 8 entries generated · review next", or the indeterminate form.
 *
 * The counts are the server's numbers, never derived from its prose — see
 * `compile:progress`. With no counts (an older server) the strip says only
 * that it is working, which is the honest answer and still better than the
 * silence this story replaces.
 */
export function stripHeadline(tail: CompileTail): string {
  if (tail.phase === 'review') return 'Compiling code-behind — reviewing the generated file';
  if (tail.done === null || tail.total === null) return 'Compiling code-behind…';
  const suffix = tail.reviewPending ? ' · review next' : '';
  return `Compiling code-behind — ${tail.done} of ${tail.total} entries generated${suffix}`;
}

/** The strip's dimmed second line, or null when there is nothing to name. */
export function stripDetail(tail: CompileTail): string | null {
  if (tail.phase === 'review') return 'Reviewing the whole file before it is proposed';
  if (tail.step === undefined) return null;
  return tail.line === undefined
    ? `Generating step ${tail.step}`
    : `Generating step ${tail.step} — line ${tail.line}`;
}

/** 0..1 for a determinate bar, or null when the counts are unknown. */
export function stripFraction(tail: CompileTail): number | null {
  if (tail.done === null || tail.total === null || tail.total <= 0) return null;
  return Math.max(0, Math.min(1, tail.done / tail.total));
}

/**
 * The status bar item's text, for every tail running anywhere in the window.
 *
 * One compile names its file, because with one tail the file IS the news.
 * Several name only the count: the item is a glance, and two filenames in the
 * status bar is a sentence. Empty means hide the item — a tail that has ended
 * has nothing to say and an idle spinner is a lie.
 */
export function statusBarText(tails: readonly CompileTail[]): string {
  if (tails.length === 0) return '';
  if (tails.length === 1) {
    const t = tails[0]!;
    const counts = t.done === null || t.total === null ? '' : ` ${t.done}/${t.total}`;
    return `$(sync~spin) Steptix: compiling ${t.file}${counts}`;
  }
  return `$(sync~spin) Steptix: compiling ${tails.length}`;
}

/** Hover text for the status bar item. */
export function statusBarTooltip(tails: readonly CompileTail[]): string {
  if (tails.length === 0) return '';
  if (tails.length === 1) return `${quickPickLabel(tails[0]!)} — click to open`;
  return `${tails.length} code-behind compiles running — click to pick one`;
}

/** One row of the several-compiles quick-pick: "securebank.md — 5 of 8 · generating". */
export function quickPickLabel(tail: CompileTail): string {
  const counts = tail.done === null || tail.total === null ? '' : ` — ${tail.done} of ${tail.total}`;
  const phase = tail.phase === 'review' ? ' · reviewing' : ' · generating';
  return `${tail.file}${counts}${phase}`;
}

/**
 * The notification's detail line, or '' before any counts arrive.
 *
 * VS Code renders the message once and the detail on every report, so the
 * file name lives in the title and the numbers live here.
 */
export function notificationDetail(tail: CompileTail): string {
  if (tail.phase === 'review') return 'reviewing the generated file';
  if (tail.done === null || tail.total === null) return '';
  const step = tail.step === undefined ? '' : ` · step ${tail.step}`;
  return `${tail.done} of ${tail.total} entries generated${step}`;
}

/**
 * How much of the bar to add, as a percentage of the whole, given the last
 * fraction already reported.
 *
 * `vscode.Progress.report({ increment })` is a DELTA, not a position: reporting
 * 60 twice fills the bar to 120%. Callers keep the last fraction and feed it
 * back here, so a progress event that arrives out of order (or repeats a count)
 * adds nothing rather than winding the bar backwards, which VS Code cannot
 * render anyway.
 */
export function progressIncrement(tail: CompileTail, lastFraction: number): number {
  const now = stripFraction(tail);
  if (now === null) return 0;
  return Math.max(0, now - lastFraction) * 100;
}
