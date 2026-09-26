/**
 * What a clean `frame:pop` paints on its CALL line, when that line is also a
 * guard (stories/codebehind-loops-and-conditions.md, decision 15).
 *
 * Pure, no VS Code dependency, so the fast `node --test` suite can pin it — the
 * split `step-skip-core.ts` and `failure-outcome-core.ts` are on.
 *
 * **The collision.** A guard line with a section tail is two things on one
 * line: the decision (`If the Cash checkbox is ticked`) and the call (`then Pay
 * with cash`). The server reports both on that line. The guard's own `step:pass`
 * comes first and, once its condition ran as code-behind, carries
 * `fromCodeBehind` / `codeBehindStale` — so the line paints `</>` or ⚠. Then the
 * tail's section frame is pushed with `line` equal to the guard's line, which
 * paints it ▶, and its clean `frame:pop` paints the call line ✓. That ✓ was
 * unconditional, so it erased the one mark on the line that said how the
 * decision was made, and the ⚠'s hover — the only place that says WHAT the
 * condition's code threw — with it.
 *
 * **The rule.** A clean pop repaints the call line with the mark a `step:pass`
 * put on that same line earlier in this run when that mark was `</>` or ⚠, and
 * with plain ✓ otherwise, exactly as before. The ✓ the pop paints means "the
 * section ran to the end"; the code mark means that too — a guard that holds is
 * a pass — and also says how the line was decided, so it is the more
 * informative of two true statements.
 *
 * Remembered rather than read back off the line, for the reason `toleratedLines`
 * is (extension.ts): the line does not keep it. The frame's `frame:push` paints
 * `running` over the mark and drops its hover detail before the pop arrives.
 *
 * What it does NOT touch: a failed descent (the pop paints nothing, as before),
 * and every precedence rule of the `step:pass` that recorded the mark — it
 * records only what that pass actually painted.
 */

/** The two pass marks a clean `frame:pop` must not flatten to ✓. */
export type GuardCodeMark = 'pass-code-behind' | 'pass-stale';

/** What a clean `frame:pop` paints on its call line, and the hover detail with it. */
export interface FramePopMark<D> {
  status: 'pass' | GuardCodeMark;
  /** Present only with a remembered ⚠: the code-behind crash its hover shows. */
  detail?: D;
}

/** Is `status` a mark a clean `frame:pop` keeps on its call line? */
export function isGuardCodeMark(status: string | undefined): status is GuardCodeMark {
  return status === 'pass-code-behind' || status === 'pass-stale';
}

/**
 * The marks guard `step:pass` events left on lines this run, keyed by the URI
 * the mark landed on and the 1-based line.
 *
 * One instance for the whole registry, like `toleratedLines`: the key already
 * carries the document, and a run's start clears its documents through the same
 * `clearStatusesFor` path that wipes the statuses — so a mark is always this
 * run's.
 *
 * Generic over the detail type so this file needs nothing from runner-core; the
 * extension instantiates it with `StepFailureDetail`.
 */
export class GuardMarks<D> {
  private readonly byUri = new Map<string, Map<number, { status: GuardCodeMark; detail?: D }>>();

  /**
   * Record what a `step:pass` painted on a line. Called only when it DID paint
   * — a pass the ✗ / amber / skip precedence refused leaves no mark, so it
   * leaves the memory as it was.
   *
   * The latest pass wins, which is what a loop needs: every visit of a `While`
   * emits its own guard `step:pass`, and the pop after it must show THAT
   * visit's mark. Anything other than `</>` / ⚠ — a plain ✓ (the model decided
   * this visit), a ◌, an amber ✗ — forgets the line, so the pop paints ✓ as it
   * always did.
   */
  notePass(uri: string, line: number, status: string, detail?: D): void {
    if (isGuardCodeMark(status)) {
      const entry = detail === undefined ? { status } : { status, detail };
      const lines = this.byUri.get(uri);
      if (lines) lines.set(line, entry);
      else this.byUri.set(uri, new Map([[line, entry]]));
      return;
    }
    const lines = this.byUri.get(uri);
    if (!lines) return;
    lines.delete(line);
    if (lines.size === 0) this.byUri.delete(uri);
  }

  /**
   * What a clean `frame:pop` paints on its call line: the remembered `</>` /
   * ⚠ with its detail, or plain ✓ when the line has none.
   *
   * Read, not consumed. A nested frame's pop paints its ROOT call line too, so
   * one guard line can be repainted by several pops in a row (a `While` whose
   * body calls a section) — each must see the same mark.
   */
  forFramePop(uri: string, line: number): FramePopMark<D> {
    const entry = this.byUri.get(uri)?.get(line);
    if (!entry) return { status: 'pass' };
    return entry.detail === undefined
      ? { status: entry.status }
      : { status: entry.status, detail: entry.detail };
  }

  /** Forget every mark on one document — its statuses were just cleared. */
  clear(uri: string): void {
    this.byUri.delete(uri);
  }
}
