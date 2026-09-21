/**
 * The impure half of control flow: what the three run loops share
 * (stories/control-flow.md §Runtime).
 *
 * [control-flow.ts](control-flow.ts) is the pure planner — it decides what to
 * skip and where to go next, and knows nothing about pages, models or step
 * results. This module is the layer immediately above it: it obtains the
 * verdict the planner asks for (one model call, or one variable read), turns a
 * failed guard into the sentence the author reads, and tracks which loop pass
 * is running so a result can be stamped with its band.
 *
 * It exists because there are THREE run loops — the CLI
 * ([test-runner.ts](test-runner.ts)), the Sessions API
 * ([../server/session-manager.ts](../server/session-manager.ts)) and the
 * Electron UI ([../ui/main/runner-adapter.ts](../ui/main/runner-adapter.ts)) —
 * and every rule that lives in only one of them is a rule the other two get
 * wrong. What is deliberately NOT here is emission: each loop pushes results,
 * paints lines and (on the server) emits frame events its own way, and those
 * differences are real.
 */

import type { AiInteraction, LoopMarker, StepResult } from '../report/types.js';
import {
  chainMembersFrom,
  exitFrom,
  forEachPassOf,
  parseListValue,
  planAfterGuard,
  planAtGuard,
  type ControlPlan,
  type ControlRecord,
  type ControlState,
  type GuardRequest,
  type GuardVerdict,
} from './control-flow.js';
import { decideConditionLocally, localReasoning } from './literal-decision.js';
import { clearDottedKeys, placeholderRoot } from '../parser/parameters.js';
import {
  boundValue,
  dottedReferenceError,
  type PlaceholderValues,
} from './placeholder-substitution.js';
import { redact, runSecrets } from '../utils/secrets.js';
import { markLoopBindings } from '../utils/loop-bindings.js';
import { logger } from '../utils/logger.js';
import { evaluateConditions } from './step-executor.js';
import type { ConditionVerdict, StepExecutorOptions } from './step-executor.js';

/** A loop record, narrowed — the three kinds that own a body and a label. */
export type LoopRecord = Extract<ControlRecord, { label: string }>;

/** True for a `While` / `Repeat` / `For each` record. */
export function isLoopRecord(record: ControlRecord): record is LoopRecord {
  return record.kind === 'while' || record.kind === 'repeat' || record.kind === 'foreach';
}

/**
 * Write one loop pass's bindings into the live variable map, clearing the
 * previous pass's dotted ones first
 * (docs/specs/SPEC-structured-table-reads.md §8.2, §8.3).
 *
 * ## Why this is not `Object.assign`
 *
 * It was, in all three run loops, and rows are not all the same shape. Over
 * `[{"_row":"1","id":"A","note":"first"},{"_row":"2","id":"B"}]`, pass 1
 * writes `row`, `row._row`, `row.id`, `row.note`; pass 2 writes three of those
 * four and leaves `row.note` where it was. So `{{row.note}}` on pass 2
 * substituted `first` — the PREVIOUS row's note, printed, asserted on and
 * typed into the page as if it belonged to row 2 — and §8.3's refusal, whose
 * whole job is to say `{{row.note}} has no value in For each item 2`, could
 * not fire, because the key was there.
 *
 * It needs no debugger and no odd row to reach. Two sequential `For each`
 * loops sharing an item name do it, and so does a loop over a list of scalars
 * after one over records: nothing about a scalar pass writes `{{row.id}}`, so
 * `{{row.id}}` still holds the last record's id, for every pass of the second
 * loop.
 *
 * ## What it clears, and what it deliberately does not
 *
 * For each ROOT the incoming bindings name — `row`, from `row` and `row.id`
 * alike — every `row.<anything>` already in the map goes, and then the new
 * bindings are assigned. Nothing else is touched: a different loop's `order.x`
 * survives, and so does a flat `row` when a later pass happens not to rebind
 * it (it always does, since a pass always binds its base name).
 *
 * §8.2's "the last pass's bindings remain after the loop" is unchanged. A loop
 * that has ENDED binds nothing more, so nothing clears its keys; they are
 * cleared when, and only when, the same root is bound again.
 */
export function applyPassBindings(
  map: Record<string, string>,
  bindings: Record<string, string>,
): void {
  const roots = new Set<string>();
  for (const key of Object.keys(bindings)) roots.add(placeholderRoot(key));
  clearDottedKeys(map, roots);
  // `defineProperty` per key, not `Object.assign`, for the reason
  // `bindVariable` gives: assignment hits `Object.prototype`'s setter for a
  // binding named `__proto__`, which ignores a string. `passBindings` builds
  // its object with a COMPUTED key, so `__proto__` really is an own property
  // of `bindings` and really did reach this line — `For each {{__proto__}} in
  // {{orders}}` parses, and bound the dotted keys while the flat name stayed
  // literal, which is half a pass with nothing said about the other half.
  //
  // Not `bindVariable` in a loop: the clear above is for the WHOLE pass, and
  // doing it per key would make the result depend on whether the flat name
  // happened to come before its properties.
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(map, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  // Say which of these names are a pass's, so the masking rules read them by
  // the two-segment rule and everything else dotted in the map — a data
  // file's `user.apikey` heading — by the author's (§7.6).
  markLoopBindings(
    map,
    Object.keys(bindings).filter((key) => key.includes('.')),
  );
}

/** What one visit to a guard produced. */
export interface GuardEvaluation {
  /** The planner's answer. Present even on failure, so a caller that carries
   *  on has somewhere to go. */
  plan: ControlPlan;
  /**
   * Whether a decision was actually made here.
   *
   * False for the visits that ask nobody — a `Repeat`'s first pass, a `For
   * each` continuing on a cursor it already holds — and those get no guard
   * result row, because the story's "one result per evaluation" is about the
   * cost of the decisions and those cost nothing.
   */
  evaluated: boolean;
  /** The model's words, when a model was asked. */
  reasoning?: string;
  /** Every judge turn, so a guard's cost is as visible as a step's. */
  aiInteractions: AiInteraction[];
  /** The guard itself failed: a cap breach, a `For each` over a non-list, or a
   *  judge that could not decide. The caller fails the guard and stops. */
  error?: string;
  durationMs: number;
}

/**
 * Visit the guard at `index`: ask whatever the planner needs asked, then plan.
 *
 * The one impure step in the whole feature. Everything it can go wrong with
 * comes back as {@link GuardEvaluation.error} — except an abort, which is
 * rethrown so the caller can end the run as 'aborted' rather than 'failed'
 * (issues/020's rule, applied to the judge as it already is to the watch).
 */
export async function evaluateGuard(args: {
  controls: readonly (ControlRecord | null)[];
  index: number;
  state: ControlState;
  /** This run's live variable map — where a `For each` reads its list. */
  resolvedParameters: Record<string, string>;
  /** Options for the judge's model call. */
  executorOptions: StepExecutorOptions;
  /**
   * This run's masker, for the one string this module writes that can carry a
   * VALUE: a locally decided condition's reasoning.
   *
   * Each run loop has its own — the server's `secretsNow` counts frame inputs
   * as well as the parameter map — so it is passed in rather than derived.
   * Omitted, the fallback below is what the CLI and the Electron adapter build
   * for themselves anyway, so a caller that forgets still masks.
   */
  redact?: ((text: string) => string) | undefined;
}): Promise<GuardEvaluation> {
  const { controls, index, state, resolvedParameters, executorOptions } = args;
  const redactText =
    args.redact ??
    ((text: string) =>
      redact(text, runSecrets({ parameters: resolvedParameters, envData: executorOptions.envData })));
  const startedAt = Date.now();
  const request = planAtGuard(controls, index, state);
  /** What a condition's placeholders hold right now — the same two syntaxes
   *  and the same live map the step text resolves against, so a condition and
   *  the tail below it can never disagree about what `{{order.status}}` is. */
  const values: PlaceholderValues = {
    parameters: resolvedParameters,
    ...(executorOptions.envData !== undefined && { envData: executorOptions.envData }),
  };

  // A dotted reference the pass cannot answer, refused before anything is
  // asked — the guard's twin of the step path's check
  // (docs/specs/SPEC-structured-table-reads.md §8.3). It lives HERE, in the
  // one place all three run loops share, because the three dispatch their
  // guards at different points: the server resolves every step's text before
  // the control dispatch and so caught this incidentally, while the CLI and
  // the Electron adapter dispatch the guard first and sent
  // `If "{{order.missing}}" is empty` to the judge with the braces intact.
  //
  // The WHOLE chain is refused over one bad member, for the same reason
  // `checkTurnReferences` refuses a whole turn: the judge is asked one
  // question about every member at once, so there is no such thing as running
  // the good half of it.
  for (const text of conditionTexts(request)) {
    const refusal = dottedReferenceError(
      text,
      resolvedParameters,
      (item) => forEachPassOf(controls, state, item),
      // The refusal names the row's properties and the keys the loop dropped,
      // either of which can carry a secret — masked on the same terms as the
      // `cannot be referenced as a placeholder` line below.
      redactText,
    );
    if (refusal === undefined) continue;
    return {
      plan: { skip: [], next: exitFailed(controls, index) },
      evaluated: true,
      aiInteractions: [],
      error: refusal,
      durationMs: Date.now() - startedAt,
    };
  }

  let verdict: GuardVerdict;
  let reasoning: string | undefined;
  let aiInteractions: AiInteraction[] = [];
  let judgeError: string | undefined;

  try {
    switch (request.ask) {
      case 'chain': {
        const conditions = request.conditions.map((c) => c.condition);
        const local = decideLocally(conditions, values, redactText);
        const judged = local ?? (await evaluateConditions(conditions, executorOptions));
        reasoning = judged.reasoning;
        aiInteractions = judged.aiInteractions;
        // Back to ABSOLUTE indices: the judge answered about a list the
        // planner built, and the planner reads step positions. `null` stays
        // null — the planner turns "none" into the `Otherwise` itself.
        verdict = {
          kind: 'chain',
          selected:
            judged.selected === null
              ? null
              : (request.conditions[judged.selected]?.index ?? null),
        };
        break;
      }
      case 'condition': {
        const conditions = [request.condition];
        const local = decideLocally(conditions, values, redactText);
        const judged = local ?? (await evaluateConditions(conditions, executorOptions));
        reasoning = judged.reasoning;
        aiInteractions = judged.aiInteractions;
        verdict = { kind: 'condition', holds: judged.selected === 0 };
        break;
      }
      case 'list': {
        // `boundValue`, not a bare index: `For each {{row}} in {{constructor}}`
        // would otherwise hand the parser the `Object` FUNCTION off the
        // prototype of a map that binds no such list, in place of the
        // "nothing binds it" error the author needs.
        const parsed = parseListValue(request.list, boundValue(resolvedParameters, request.list));
        if ('error' in parsed) {
          return {
            plan: { skip: [], next: exitFailed(controls, index) },
            evaluated: true,
            aiInteractions: [],
            error: parsed.error,
            durationMs: Date.now() - startedAt,
          };
        }
        if (parsed.unspellable !== undefined) {
          // Keys that bound nothing — `content-type`, `Order ID` — said once
          // per loop ENTRY, which is what this branch is: a pass that resumes
          // a cursor it already holds asks the planner nothing and reads no
          // list, so the line cannot repeat per pass
          // (docs/specs/SPEC-structured-table-reads.md §8.2).
          //
          // `info` rather than `warn`, because nothing is wrong: the loop
          // runs, and the author needs this only if they go looking for
          // `{{order.contenttype}}`. Masked, like every other string this
          // module writes from a run's values — a key can carry one.
          const record = controls[index];
          const item = record?.kind === 'foreach' ? record.item : request.list;
          const n = parsed.unspellable.length;
          const said =
            n === 1
              ? '1 property cannot be referenced as a placeholder'
              : `${n} properties cannot be referenced as placeholders`;
          logger.info(
            redactText(`For each {{${item}}}: ${said} (${parsed.unspellable.join(', ')})`),
          );
        }
        // `properties` rides along beside `items`: the planner turns it into
        // `{{item.property}}` bindings, and a list of scalars carries an
        // entry of `undefined` per element rather than nothing at all
        // (SPEC-structured-table-reads.md §8.2).
        verdict = { kind: 'list', items: parsed.items, properties: parsed.properties };
        reasoning = `\`{{${request.list}}}\` holds ${parsed.items.length} item${
          parsed.items.length === 1 ? '' : 's'
        }`;
        break;
      }
      default:
        verdict = { kind: 'resume' };
        break;
    }
  } catch (err) {
    // A stop mid-judge is a stop, not a failure. Rethrown for the caller's own
    // abort handling; anything else fails this guard with the judge's words.
    if (executorOptions.signal?.aborted || (err as Error | undefined)?.name === 'AbortError') {
      throw err;
    }
    judgeError = err instanceof Error ? err.message : String(err);
    return {
      plan: { skip: [], next: exitFailed(controls, index) },
      evaluated: true,
      aiInteractions,
      error: judgeError,
      durationMs: Date.now() - startedAt,
    };
  }

  const plan = planAfterGuard(controls, index, verdict, state);
  const record = controls[index];
  return {
    plan,
    evaluated: request.ask !== 'nothing',
    ...(reasoning !== undefined && { reasoning }),
    aiInteractions,
    ...(plan.capBreached &&
      record &&
      isLoopRecord(record) && { error: capBreachMessage(record, plan.capBreached) }),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * The condition texts a guard visit is about to ask about — a chain's
 * members, or one loop condition.
 *
 * Empty for a `For each` (its list name is flat, and `parseListValue` owns
 * what that must hold) and for a visit that asks nobody.
 */
function conditionTexts(request: GuardRequest): readonly string[] {
  if (request.ask === 'chain') return request.conditions.map((c) => c.condition);
  if (request.ask === 'condition') return [request.condition];
  return [];
}

/**
 * A chain or a loop condition decided from its own text, with no model call —
 * or null when the page is genuinely needed
 * (src/parser/literal-condition.ts has the grammar and the run that motivated
 * it).
 *
 * ALL OR NOTHING for a chain, and that is the whole of the design decision
 * here. The judge is asked one question about the whole chain and answers
 * first-holds-wins, so deciding member A locally and asking about B and C
 * would be two decisions where the author wrote one — and the judge, shown a
 * shorter list, would answer about a different question than the one the
 * planner is holding indices for. If any member needs the page, the chain goes
 * to the judge exactly as it did before this existed, unsubstituted text and
 * `## Values` block included.
 *
 * Returns a {@link ConditionVerdict}, the judge's own shape, so the caller has
 * one code path: same `selected`, same `reasoning` slot, and `aiInteractions`
 * empty because nothing was asked. That is what keeps the guard row, the loop
 * marker, the report and TestBench identical to a judged decision — the only
 * visible difference is whose words are in `aiExplanation`.
 *
 * The rule itself — substitute as quoted literals, refuse a condition whose
 * AUTHORED text made no reference, redact — lives in
 * [literal-decision.ts](literal-decision.ts), because a flow-control line's
 * condition (`If {{payment.status}} is "Overdue", then return`) is judged in
 * the step executor and never reaches this function at all. Two judges, one
 * rule.
 */
function decideLocally(
  conditions: readonly string[],
  values: PlaceholderValues,
  redactText: (text: string) => string,
): ConditionVerdict | null {
  const decided: Array<{ text: string; holds: boolean }> = [];
  for (const condition of conditions) {
    const local = decideConditionLocally(condition, values, redactText);
    if (!local) return null;
    decided.push({ text: local.text, holds: local.holds });
  }
  if (decided.length === 0) return null;

  const selected = decided.findIndex((d) => d.holds);
  if (selected >= 0) {
    const winner = decided[selected]!;
    const reasoning = localReasoning(winner.text, true);
    // Mirrors `evaluateConditions`' own line, label and all, so anything
    // reading the run log for `Condition judge:` sees this decision too. The
    // reasoning says who decided it. The AUTHORED condition is quoted here —
    // it holds references, not values, so it needs no masking.
    logger.debug(
      `Condition judge: ${String.fromCharCode(65 + selected)} ("${conditions[selected]}") held — ${reasoning}`,
    );
    return { selected, reasoning, aiInteractions: [] };
  }

  const reasoning = `decided from the values: none held — ${decided
    .map((d) => `${d.text} → false`)
    .join(', ')}`;
  // The reasoning already opens with `none held`; the log line prefixes the
  // label and nothing else, or it read `Condition judge: none held — decided
  // from the values: none held — …`.
  logger.debug(`Condition judge: ${reasoning}`);
  return { selected: null, reasoning, aiInteractions: [] };
}

/**
 * Where a run that carries on past a FAILED guard should go.
 *
 * The structure the guard opened is over — a chain's last step, a loop's — so
 * the exit is the enclosing structure's, exactly as it is for a guard that
 * ended normally ({@link exitFrom}). Every caller today fails the run here, so
 * this only decides where one that kept going would land; it costs a line to
 * make that the same answer the planner gives everywhere else.
 */
function exitFailed(
  controls: readonly (ControlRecord | null)[],
  index: number,
): number {
  const record = controls[index];
  if (!record) return index + 1;
  return exitFrom(controls, 'chainEnd' in record ? record.chainEnd : record.bodyEnd, index);
}

/**
 * What a loop that ran out of passes says (stories/control-flow.md, decision 9).
 *
 * Names the cap AND where the cap came from, because the two have different
 * fixes: a line's own `, up to N times` is edited on the line, and the config
 * default is edited in `aiui.config.json`. Both ways out are spelled, along
 * with the third possibility — that the exit condition is wrong and no cap
 * would have helped.
 */
export function capBreachMessage(
  record: LoopRecord,
  breach: { cap: number; source: 'line' | 'config' },
): string {
  const where =
    breach.source === 'line' ? "this line's `, up to N times`" : 'execution.maxLoopIterations';
  const condition = 'condition' in record ? record.condition : '';
  const stillWrong =
    record.kind === 'repeat'
      ? `"${condition}" was still not true`
      : `"${condition}" was still true`;
  return (
    `the loop reached its cap of ${breach.cap} passes (${where}) and ${stillWrong}; ` +
    'raise the cap on the line with `, up to N times`, or check the exit condition.'
  );
}

/**
 * One conversation-history line per guard evaluation.
 *
 * Later steps read `## Prior Steps` as evidence for what the run has already
 * done, and a run that branched is exactly where "what happened before this"
 * stops being obvious from the step list alone. Masked by the caller, like
 * every other history line (stories/placeholder-preserving-actions.md).
 */
export function guardHistoryLine(
  instruction: string,
  outcome: 'held' | 'did not hold' | 'ended' | 'failed',
): string {
  return `${instruction} → ${outcome}`;
}

/**
 * Every `## Prior Steps` line one guard visit contributes, in file order.
 *
 * The line that says `held` is the SELECTED member's, not the head of the
 * chain's — the head is merely the line the judge was asked from. A run that
 * took the `Else if` used to tell every later step that the `If` held, which
 * is the one place in a run where the evidence the model reads and what the
 * run actually did had diverged.
 *
 * Every member the judge considered and rejected gets its own `did not hold`
 * line: those are the alternatives it ruled out, in order, and they are as
 * much of the decision as the winner is. Members BELOW the selected one are
 * not mentioned — first-holds-wins means they were never asked about, and
 * saying they did not hold would be a claim nobody made.
 *
 * `text(index)` supplies the instruction for an absolute index, already masked
 * by the caller (each run loop redacts on its own terms).
 */
export function guardHistoryLines(args: {
  controls: readonly (ControlRecord | null)[];
  /** The guard the judge was asked from. */
  index: number;
  rows: GuardRows;
  plan: ControlPlan;
  text: (index: number) => string;
}): string[] {
  const { controls, index, rows, plan, text } = args;
  if (!rows.guard) return [];
  const record = controls[index];

  if (rows.guard.status === 'failed') {
    return [guardHistoryLine(text(index), 'failed')];
  }

  const isChain =
    record !== null &&
    record !== undefined &&
    (record.kind === 'if' || record.kind === 'elseif' || record.kind === 'else');
  if (!isChain) {
    return [
      guardHistoryLine(text(index), plan.loopEnded ? 'ended' : 'held'),
    ];
  }

  const selected = plan.selected ?? null;
  const lines: string[] = [];
  for (const member of chainMembersFrom(controls, index)) {
    if (selected !== null && member === selected) {
      lines.push(guardHistoryLine(text(member), 'held'));
      break;
    }
    // Past the winner: never asked, so never answered.
    if (selected !== null && member > selected) break;
    lines.push(guardHistoryLine(text(member), 'did not hold'));
  }
  return lines;
}

/** A guard's own result row. */
export function guardResult(args: {
  /** 1-based, like every other `StepResult.index`. */
  index: number;
  instruction: string;
  status: 'passed' | 'skipped' | 'failed';
  durationMs: number;
  reasoning?: string | undefined;
  error?: string | undefined;
  aiInteractions?: AiInteraction[] | undefined;
  loop?: LoopMarker | undefined;
}): StepResult {
  const interactions = args.aiInteractions ?? [];
  return {
    index: args.index,
    instruction: args.instruction,
    status: args.status,
    // One turn holding the judge's calls, and no sub-actions — a guard never
    // acts. Rendered by the report's ordinary turn block, so the model's raw
    // answer is as inspectable here as it is on a step.
    turns:
      interactions.length > 0
        ? [
            {
              turnNumber: 1,
              attemptNumber: 1,
              timestamp: interactions[0]?.timestamp ?? new Date().toISOString(),
              aiInteractions: interactions,
              subActions: [],
            },
          ]
        : [],
    durationMs: args.durationMs,
    retried: false,
    ...(args.error !== undefined && { error: args.error }),
    ...(args.reasoning !== undefined && { aiExplanation: args.reasoning }),
    ...(args.loop !== undefined && { loop: args.loop }),
  };
}

/** A step the run decided not to take. */
export function skippedResult(args: {
  index: number;
  instruction: string;
  reason: string;
  loop?: LoopMarker | undefined;
}): StepResult {
  return {
    index: args.index,
    instruction: args.instruction,
    status: 'skipped',
    turns: [],
    durationMs: 0,
    retried: false,
    aiExplanation: args.reason,
    ...(args.loop !== undefined && { loop: args.loop }),
  };
}

/** One pass of one loop, while it is running. */
interface ActivePass {
  guard: number;
  record: LoopRecord;
  marker: LoopMarker;
  /**
   * How many passes this guard has begun in the whole run, this one included.
   *
   * NOT `marker.index`: a loop nested in another loop's body restarts its
   * `iteration` at 1 on every entry (that is what makes the band read `(1/2)`
   * again), so the iteration alone cannot mint a unique frame id — the outer
   * loop's second pass would re-mint the inner loop's first-pass id and
   * overwrite it in `expansionFrames`.
   */
  ordinal: number;
  /** Server only: original frame id → this pass's clone. Empty elsewhere. */
  frameAlias: Map<string, string>;
}

/**
 * Which loop pass a step belongs to, and what the report calls it.
 *
 * The frame-derived `loopMarkerFor` the rows story shipped cannot answer this
 * on its own: a control line's tail may be a plain instruction, which produces
 * no frame at all, so there would be nothing to derive a marker from. A stack
 * of active passes answers for both shapes, and answers identically in all
 * three run loops — the server additionally clones frames, and hangs the
 * per-pass aliases off the same stack so the two can never disagree about
 * which pass is running.
 *
 * `count` is UNKNOWN while a `While` or `Repeat` runs. Markers are handed out
 * by reference and back-filled in place when the loop ends ({@link endLoop}),
 * which works because the results still live in memory when the report is
 * rendered.
 */
export class LoopRuntime {
  private readonly stack: ActivePass[] = [];
  /** Guard index → every marker handed out for it, for the back-fill. */
  private readonly issued = new Map<number, LoopMarker[]>();
  /** Guard index → passes begun for it in this run. Never reset — it is what
   *  makes a nested loop's per-pass frame ids unique across re-entries. */
  private readonly ordinals = new Map<number, number>();

  /** A pass is starting. Returns the marker its guard row and body steps carry. */
  beginPass(
    guard: number,
    record: LoopRecord,
    pass: NonNullable<ControlPlan['pass']>,
  ): LoopMarker {
    // A loop re-entering itself replaces its own top entry; a loop nested
    // inside another's body pushes on top of it.
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.guard === guard) {
      this.stack.pop();
    }
    const marker: LoopMarker = {
      kind: 'iteration',
      label: record.label,
      index: pass.iteration,
      ...(pass.count !== undefined && { count: pass.count }),
      values: { ...(pass.bindings ?? {}) },
    };
    const ordinal = (this.ordinals.get(guard) ?? 0) + 1;
    this.ordinals.set(guard, ordinal);
    this.stack.push({ guard, record, marker, ordinal, frameAlias: new Map() });
    const seen = this.issued.get(guard) ?? [];
    seen.push(marker);
    this.issued.set(guard, seen);
    return marker;
  }

  /**
   * A loop ended: fill in the count every marker of it was issued without.
   *
   * Mutates the markers in place, which is the point — they are the same
   * objects the step results already carry, so `(3/?)` becomes `(3/7)` in the
   * rendered report without the results being rewritten.
   */
  endLoop(ended: { guard: number; count: number }): void {
    for (const marker of this.issued.get(ended.guard) ?? []) {
      if (marker.count === undefined) marker.count = ended.count;
    }
    this.issued.delete(ended.guard);
    this.dropPassesFor(ended.guard);
  }

  /** A loop stopped without ending normally (a cap breach, a failed body).
   *  The count is what it managed, which is the honest number for the band. */
  abandon(guard: number, count: number): void {
    this.endLoop({ guard, count });
  }

  /** The marker for a body step, or undefined outside every loop. */
  markerFor(index: number): LoopMarker | undefined {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const pass = this.stack[k]!;
      if (index >= pass.record.bodyStart && index <= pass.record.bodyEnd) return pass.marker;
    }
    return undefined;
  }

  // (There was an `insideLoopBody` here. It had no caller, and its docstring
  //  claimed to drive the step-cache opt-out — which is really the
  //  `loopBodySteps` set each loop builds from the records once, up front
  //  (test-runner.ts, session-manager.ts). Two answers to one question, one of
  //  them unreachable, is worse than none.)

  // ── Frame aliases (the Sessions API's half) ───────────────────────────────

  /** Record that `original` is running as `clone` for the current pass. */
  aliasFrame(original: string, clone: string): void {
    this.stack[this.stack.length - 1]?.frameAlias.set(original, clone);
  }

  /**
   * Has THIS pass already cloned `original`?
   *
   * Deliberately not {@link frameFor}, which searches the whole stack: a loop
   * nested inside another loop's body sits under aliases the ENCLOSING pass
   * installed, and asking "is there an alias anywhere" made the inner loop
   * believe its frames were already cloned for this pass. Every inner pass
   * then painted into the outer pass's frame and stamped no `iteration` at
   * all. The question the clone walk actually wants is about the current pass
   * only.
   */
  clonedInCurrentPass(original: string): boolean {
    return this.stack[this.stack.length - 1]?.frameAlias.has(original) ?? false;
  }

  /** How many passes the current pass's guard has begun in this run — the
   *  monotonic half of a per-pass frame id. 0 outside every loop. */
  get currentPassOrdinal(): number {
    return this.stack[this.stack.length - 1]?.ordinal ?? 0;
  }

  /** The frame id to emit for `original` right now — its clone if a pass owns
   *  one, else the id the expander minted. */
  frameFor(original: string): string {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const clone = this.stack[k]!.frameAlias.get(original);
      if (clone !== undefined) return clone;
    }
    return original;
  }

  /** True while any loop pass is running — the cheap test a run with no
   *  control lines pays instead of a map lookup per step. */
  get active(): boolean {
    return this.stack.length > 0;
  }

  private dropPassesFor(guard: number): void {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      if (this.stack[k]!.guard === guard) this.stack.splice(k, 1);
    }
  }
}

/** Expand inclusive index ranges into the indices they name, ascending. */
export function* eachSkipped(ranges: ReadonlyArray<readonly [number, number]>): Generator<number> {
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) yield i;
  }
}

/**
 * Which rows one guard visit produces, and with what status.
 *
 * Separate from emitting them because the three run loops emit differently —
 * results arrays, SSE events, IPC messages — but must agree completely on
 * WHICH rows exist. The rules, in the story's words:
 *
 *  - a chain's selected member is `passed`, every other member and every step
 *    of every other tail is `skipped` (§"A chain is a decision", step 3);
 *  - a chain where nothing held and there is no `Otherwise` has no passed
 *    member at all, so the guard that was ASKED carries the model's reasoning
 *    as a skipped row — otherwise the one decision the run made would leave no
 *    trace anywhere;
 *  - a loop's guard is `passed` once per evaluation (§"A loop is a decision
 *    made again"), and the visits that ask nobody produce no row;
 *  - a guard that could not decide is `failed`, and nothing else is recorded:
 *    the run stops, and marking its body skipped would claim a decision was
 *    made about it.
 */
export interface GuardRows {
  /** The guard row, absolute 0-based index. Absent for an ask-nobody visit. */
  guard?: { index: number; status: 'passed' | 'skipped' | 'failed' };
  /** Steps to record as skipped, ascending, never including `guard.index`. */
  skip: number[];
}

export function guardRows(
  record: ControlRecord,
  index: number,
  evaluation: GuardEvaluation,
): GuardRows {
  if (evaluation.error !== undefined) {
    return { guard: { index, status: 'failed' }, skip: [] };
  }
  const skip = [...eachSkipped(evaluation.plan.skip)];
  if (record.kind === 'if' || record.kind === 'elseif' || record.kind === 'else') {
    const selected = evaluation.plan.selected ?? null;
    if (selected !== null) return { guard: { index: selected, status: 'passed' }, skip };
    return {
      guard: { index, status: 'skipped' },
      skip: skip.filter((k) => k !== index),
    };
  }
  if (!evaluation.evaluated) return { skip };
  return { guard: { index, status: 'passed' }, skip };
}

/** What a skipped row says about itself, in one sentence per shape. */
export function skipReasonFor(record: ControlRecord, plan: ControlPlan): string {
  if (record.kind === 'if' || record.kind === 'elseif' || record.kind === 'else') {
    return plan.selected === null || plan.selected === undefined
      ? 'Skipped: no condition in this decision held'
      : 'Skipped: another branch of this decision was taken';
  }
  if (record.kind === 'foreach') return 'Skipped: the list was empty';
  return 'Skipped: the loop ran no passes';
}

/**
 * Skipped indices waiting to be recorded, held back until the run has moved
 * past them.
 *
 * A chain's untaken members sit on BOTH sides of the taken one — `If` … `Else
 * if` … `Otherwise` skips 1–3 and 7–8 to run 4–6 — and a report that recorded
 * every skip the moment the decision was made would read 1, 2, 3, 7, 8, 4, 5,
 * 6. The queue releases an index only once the run has reached something after
 * it, so the rows stay in the order the file is written in.
 */
export class SkipQueue {
  private pending: number[] = [];
  /** Every index this queue has already handed to a caller. Read only by
   *  {@link addOnce}; see there for why `add` must not consult it. */
  private released = new Set<number>();

  add(indices: readonly number[]): void {
    this.pending.push(...indices);
    this.pending.sort((a, b) => a - b);
  }

  /**
   * Queue `indices`, but never one already queued or already released.
   *
   * For a pointer that can move BACKWARDS — the Runner UI debugger's
   * jump-to-step — `planForStart` re-plans the ranges the run has already
   * skipped, so a plain `add` gave the renderer a second
   * `runner:step-complete` for each and the report a second skipped row
   * (review 3, finding 4).
   *
   * {@link add} itself must keep duplicating, which is why this is a separate
   * door rather than a change to that one: a chain inside a loop body
   * legitimately skips the SAME indices once per pass, and the rows of the
   * untaken branch belong to their passes.
   */
  addOnce(indices: readonly number[]): void {
    for (const k of indices) {
      if (this.released.has(k) || this.pending.includes(k)) continue;
      this.pending.push(k);
    }
    this.pending.sort((a, b) => a - b);
  }

  /** Every queued index strictly below `index`, removed and returned. */
  take(index: number): number[] {
    const out: number[] = [];
    this.pending = this.pending.filter((k) => {
      if (k < index) {
        out.push(k);
        this.released.add(k);
        return false;
      }
      return true;
    });
    return out;
  }

  /**
   * Forget that `[start, end]` was ever released, so {@link addOnce} can queue
   * those indices again.
   *
   * A pass of a loop body OWES the rows every other pass of it emits, and
   * `released` is the run's memory of what has already been reported — a
   * memory that must not outlive the pass when the caller is about to start a
   * new one. Without this, a jump INTO a loop body from outside it produced a
   * visit with no skipped rows at all: the chain inside the body had released
   * those indices on an earlier pass, so `addOnce` refused them and the
   * untaken branch simply vanished from the report (review 4, finding 5).
   *
   * The same range, and the same reason, as `rearmLoopBreakpoints` on the
   * server: a loop's own `[bodyStart, bodyEnd]`, and only where a pass starts.
   */
  rearm(start: number, end: number): void {
    for (const k of [...this.released]) {
      if (k >= start && k <= end) this.released.delete(k);
    }
  }

  /** Whatever is left, at the end of the run. */
  takeAll(): number[] {
    const out = this.pending;
    for (const k of out) this.released.add(k);
    this.pending = [];
    return out;
  }

  get size(): number {
    return this.pending.length;
  }
}
