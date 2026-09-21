/**
 * The control-flow planner (stories/control-flow.md §Runtime).
 *
 * Four run loops execute steps — the CLI, the Sessions API, the Electron UI,
 * and MCP/errands through the server — and none of them should grow a second
 * interpreter. So the decisions that a chain or a loop implies for the flat
 * step list live here, in one pure module: no I/O, no page, no clock, no
 * model. Given the `controls` array the expander produced, a step index, and a
 * verdict the caller obtained, it answers "what do I mark skipped, and where
 * do I go next".
 *
 * ## The shape of a run loop's three hooks
 *
 * ```ts
 * // At batch start, once:
 * const plan = planForStart(controls, startIndex, state);
 * markSkipped(plan.skip);                       // ranges, inclusive
 *
 * // Before executing step i:
 * const record = controls[i];
 * if (record) {
 *   const request = planAtGuard(controls, i, state);
 *   const verdict = await gather(request);      // the ONE impure part
 *   const plan = planAfterGuard(controls, i, verdict, state);
 *   if (plan.capBreached) return failGuard(i, plan.capBreached);
 *   markSkipped(plan.skip);
 *   if (plan.selected != null) markPassed(plan.selected);
 *   if (plan.loopEnded) backfillLoopCount(plan.loopEnded);
 *   i = plan.next;                              // plan.pass describes the
 *   continue;                                   // iteration about to run
 * }
 *
 * // After executing step i:
 * const after = planAfterStep(controls, i, state);
 * i = after ? after.next : i + 1;
 * ```
 *
 * `gather` is where the impurity lives: a chain asks the model once for the
 * first condition that holds (`evaluateConditions`), a `While` / `Repeat` asks
 * for one condition, a `For each` reads a variable and validates it with
 * {@link parseListValue}, and `{ ask: 'nothing' }` asks nobody — a `Repeat`'s
 * first pass runs its body before there is anything to decide.
 *
 * ## What is NOT here
 *
 * Frame cloning, `iteration` / `iterationCount` stamping, result statuses and
 * the model call itself. The planner says which pass is starting
 * ({@link ControlPlan.pass}) and which indices are dead; turning that into
 * frames and events is each run loop's own job, because each one already has
 * its own way of emitting them.
 */

/**
 * What the expander recorded about one guard, keyed by the guard's own
 * absolute index in the flat step list (stories/control-flow.md §Design).
 *
 * Every index is absolute, so the records survive `startAt` / `endAt` slicing,
 * which the server does by absolute index already. Nesting is by containment:
 * a chain inside a tail's section body has ranges strictly inside the outer
 * body's range.
 */
export type ControlRecord =
  | {
      kind: 'if' | 'elseif' | 'else';
      /** Shared by every member of one chain. */
      chainId: string;
      /** Absent on `'else'`. */
      condition?: string;
      /** Absolute index of the tail's first step. */
      bodyStart: number;
      /** … and its last (inclusive). */
      bodyEnd: number;
      /** Absolute index of the chain's last step — the last member's
       *  `bodyEnd`, shared by every member. */
      chainEnd: number;
    }
  | {
      kind: 'while' | 'repeat';
      condition: string;
      bodyStart: number;
      bodyEnd: number;
      /** From `, up to N times`; {@link ControlState.defaultCap} otherwise. */
      cap?: number;
      /** The section's name for a section tail, the tail's own text
       *  otherwise. What a loop band is labelled with. */
      label: string;
    }
  | {
      kind: 'foreach';
      item: string;
      list: string;
      bodyStart: number;
      bodyEnd: number;
      label: string;
    };

/** A chain member's record, narrowed. */
export type ChainRecord = Extract<ControlRecord, { chainId: string }>;

export function isChainRecord(record: ControlRecord): record is ChainRecord {
  return record.kind === 'if' || record.kind === 'elseif' || record.kind === 'else';
}

/** `execution.maxLoopIterations`' default. A loop line's own `, up to N
 *  times` wins over it. */
export const DEFAULT_MAX_LOOP_ITERATIONS = 25;

/** Where a `For each` has got to. `items` is null until the list has been
 *  read, which happens on the guard's first evaluation. */
export interface ForEachCursor {
  items: string[] | null;
  /**
   * Per item, the direct properties an OBJECT element exposes as dotted
   * bindings — `{ _row: '1', id: 'ORD-1001' }` for
   * `{"_row":"1","id":"ORD-1001"}` (SPEC-structured-table-reads.md §8.2).
   * Absent entries are scalars, which bind their base name and nothing else.
   *
   * Parallel to `items` rather than folded into it because `items` is the
   * loop's own list — what `count` reports, what `index` walks — and every
   * existing reader of it expects one string per pass.
   */
  properties?: Array<Record<string, string> | undefined> | undefined;
  /** Index of the element the current pass is bound to; -1 before the first. */
  index: number;
  /**
   * True when the run STARTED inside this loop's body (a `startAt` landing in
   * a tail). The partial pass counts as pass 1, so the list is entered at its
   * second element — the story's "the pass number restarts at 1, because the
   * count lived in the batch that was paused", made concrete.
   */
  resumed: boolean;
}

/** Per-run mutable bookkeeping. One instance per run; the planner is pure in
 *  the sense that every effect it has is on this object and its return value. */
export interface ControlState {
  /** `execution.maxLoopIterations`, for a loop line that named no cap. */
  defaultCap: number;
  /** Guard index → passes STARTED so far. */
  passes: Map<number, number>;
  /** Guard index → `For each` cursor. */
  cursors: Map<number, ForEachCursor>;
}

export function createControlState(
  defaultCap: number = DEFAULT_MAX_LOOP_ITERATIONS,
): ControlState {
  return { defaultCap, passes: new Map(), cursors: new Map() };
}

/** What the runtime must gather before {@link planAfterGuard} can answer. */
export type GuardRequest =
  | {
      ask: 'chain';
      /** In authored order, first-holds-wins. An `Else` / `Otherwise` member
       *  carries no condition and is therefore absent — {@link fallback}
       *  names it instead. */
      conditions: Array<{ index: number; condition: string }>;
      /** The `Else` / `Otherwise` member's index, or null. The caller does
       *  NOT need to apply it: reporting `selected: null` selects it. */
      fallback: number | null;
    }
  | { ask: 'condition'; condition: string }
  | { ask: 'list'; list: string }
  /** Nothing to decide: a `Repeat`'s first pass, or a `For each` continuing on
   *  a cursor it already has. Answer with `{ kind: 'resume' }`. */
  | { ask: 'nothing' };

/** What the runtime gathered. */
export type GuardVerdict =
  /** `selected` is the ABSOLUTE index of the member whose condition held, or
   *  null for "none held" — which selects the `Otherwise` if the chain has
   *  one, and skips the chain if it does not. */
  | { kind: 'chain'; selected: number | null }
  | { kind: 'condition'; holds: boolean }
  /** `properties`, when present, is parallel to `items`: the direct properties
   *  of an OBJECT element, which become `{{item.property}}` bindings (§8.2).
   *  Optional so a caller that builds a verdict by hand — every scalar test in
   *  this repo — keeps working unchanged. */
  | { kind: 'list'; items: string[]; properties?: Array<Record<string, string> | undefined> }
  | { kind: 'resume' };

export interface ControlPlan {
  /** Steps to mark skipped before continuing, as inclusive index ranges,
   *  ascending and non-overlapping. */
  skip: Array<[number, number]>;
  /** Index to continue from. */
  next: number;
  /**
   * Chains only: the member whose tail was selected — the caller marks THAT
   * guard `passed`. `null` means no member held and the chain had no
   * `Otherwise`, so every member is in `skip`. Absent for loops.
   */
  selected?: number | null;
  /** For loops: the pass that is starting, when a body is about to run.
   *  `count` is absent while a `While` / `Repeat` is still running. */
  pass?: { iteration: number; count?: number; bindings?: Record<string, string> };
  /** The loop ran its cap and its exit condition still had not been met. The
   *  caller fails the guard; `next` and `skip` are what a caller that carries
   *  on regardless should use. */
  capBreached?: { cap: number; source: 'line' | 'config' };
  /** A loop just ended normally: back-fill `count` on every marker of it. */
  loopEnded?: { guard: number; count: number };
}

/** The members of the chain containing `index`, from `index` onward.
 *
 *  From `index` rather than from the head so a run whose `startAt` landed on
 *  an `Else if` evaluates that member and the ones after it, rather than
 *  silently re-asking conditions whose steps are not in the batch. */
export function chainMembersFrom(
  controls: readonly (ControlRecord | null)[],
  index: number,
): number[] {
  const record = controls[index];
  if (!record || !isChainRecord(record)) return [];
  const members: number[] = [];
  for (let j = index; j <= record.chainEnd && j < controls.length; j++) {
    const other = controls[j];
    if (other && isChainRecord(other) && other.chainId === record.chainId) members.push(j);
  }
  return members;
}

/** Every member of the chain containing `index`, head included. */
export function chainMembers(
  controls: readonly (ControlRecord | null)[],
  index: number,
): number[] {
  const record = controls[index];
  if (!record || !isChainRecord(record)) return [];
  const members: number[] = [];
  for (let j = 0; j < controls.length; j++) {
    const other = controls[j];
    if (other && isChainRecord(other) && other.chainId === record.chainId) members.push(j);
  }
  return members;
}

/** What to gather before evaluating the guard at `index`. */
export function planAtGuard(
  controls: readonly (ControlRecord | null)[],
  index: number,
  state: ControlState,
): GuardRequest {
  const record = controls[index];
  if (!record) return { ask: 'nothing' };

  if (isChainRecord(record)) {
    const members = chainMembersFrom(controls, index);
    const conditions: Array<{ index: number; condition: string }> = [];
    let fallback: number | null = null;
    for (const j of members) {
      const member = controls[j] as ChainRecord;
      // FIRST condition-less member wins, which is what {@link fallbackOf}
      // picks too. The parser refuses a second `Otherwise` and the expander
      // does now as well, so this only arises on a malformed records array —
      // but "arises only on malformed input" is exactly when the request and
      // the plan disagreeing costs the most, so the two read the same rule.
      if (member.condition === undefined) fallback ??= j;
      else conditions.push({ index: j, condition: member.condition });
    }
    return { ask: 'chain', conditions, fallback };
  }

  if (record.kind === 'foreach') {
    const cursor = state.cursors.get(index);
    // The list is read ONCE, on entry. Later passes advance the cursor the
    // planner already holds — re-reading would let a capture made inside the
    // body change the bound of the loop it is inside.
    return cursor && cursor.items !== null ? { ask: 'nothing' } : { ask: 'list', list: record.list };
  }

  // `Repeat <tail> until <cond>` runs its body BEFORE there is anything to
  // decide; `While` decides first, every time.
  if (record.kind === 'repeat' && (state.passes.get(index) ?? 0) === 0) {
    return { ask: 'nothing' };
  }
  return { ask: 'condition', condition: record.condition };
}

/**
 * Will the visit about to happen at `index` ask anybody — and so leave a row?
 *
 * The pairing rule every run loop needs, and the reason this is a named
 * function rather than a `.ask !== 'nothing'` written out three times: a
 * guard's OPENING signal (the server's `step:start`, the Electron runner's
 * `runner:step-start`, the CLI's `logger.step` header) may only be sent for a
 * visit that will send a closing one. `guardRows` records nothing for a visit
 * that asks nobody — a `Repeat`'s first pass, and every revisit of a `For
 * each`, including the one that finds the list exhausted — so an opening
 * signal sent there is never answered. TestBench paints `running` on
 * `step:start` and clears it on the next event for that line, so an unanswered
 * one left the guard's line painted `running` after the run had finished
 * (stories/control-flow.md §"What the live run found").
 *
 * Cheap and pure: {@link planAtGuard} reads two maps and builds one object, no
 * judge and no page. Calling it here and again inside `evaluateGuard` costs
 * nothing and keeps the two answers the same one — `GuardEvaluation.evaluated`
 * is this same test applied to the request `evaluateGuard` planned.
 */
export function guardVisitEvaluates(
  controls: readonly (ControlRecord | null)[],
  index: number,
  state: ControlState,
): boolean {
  return planAtGuard(controls, index, state).ask !== 'nothing';
}

/** The guard at `index` has been evaluated (or a `For each` list read). */
export function planAfterGuard(
  controls: readonly (ControlRecord | null)[],
  index: number,
  verdict: GuardVerdict,
  state: ControlState,
): ControlPlan {
  const record = controls[index];
  if (!record) return { skip: [], next: index + 1 };

  if (isChainRecord(record)) return planChain(controls, index, record, verdict);
  if (record.kind === 'foreach') return planForEach(controls, index, record, verdict, state);
  return planConditionLoop(controls, index, record, verdict, state);
}

/** The chain's fallback member — the FIRST one carrying no condition, which is
 *  the same one {@link planAtGuard} reports. */
function fallbackOf(
  controls: readonly (ControlRecord | null)[],
  members: readonly number[],
): number | null {
  return members.find((j) => (controls[j] as ChainRecord).condition === undefined) ?? null;
}

function planChain(
  controls: readonly (ControlRecord | null)[],
  index: number,
  record: ChainRecord,
  verdict: GuardVerdict,
): ControlPlan {
  const members = chainMembersFrom(controls, index);
  const selectedRaw = verdict.kind === 'chain' ? verdict.selected : null;

  // "none" selects the `Otherwise` when there is one — the planner applies
  // that rather than every run loop applying it the same way four times.
  let chosen: number | null = selectedRaw;
  // An index that names no member of THIS chain is a caller bug (a judge
  // answering about the wrong list, a hand-built records array). Left alone it
  // is a jump to that record's `bodyStart` — backwards, if the index is behind
  // us, which is an endless run. Treated as "none" it is at worst one decision
  // reported as undecided.
  if (chosen !== null && !members.includes(chosen)) chosen = null;
  if (chosen === null) chosen = fallbackOf(controls, members);

  const chosenRecord = chosen === null ? null : controls[chosen];
  if (chosen === null || !chosenRecord || !isChainRecord(chosenRecord)) {
    // Nothing held and there is no `Otherwise`: the whole chain from here on
    // is dead, and the run continues after it — at the enclosing structure's
    // own exit, not blindly at `chainEnd + 1` ({@link exitFrom}).
    return {
      skip: [[index, record.chainEnd]],
      next: exitFrom(controls, record.chainEnd, index),
      selected: null,
    };
  }
  // A member's span is its guard plus its tail, and they are contiguous — the
  // tail is expanded in place, immediately after the guard.
  const skip = mergeRanges(
    members
      .filter((j) => j !== chosen)
      .map((j) => [j, (controls[j] as ChainRecord).bodyEnd] as [number, number]),
  );
  return { skip, next: chosenRecord.bodyStart, selected: chosen };
}

function planForEach(
  controls: readonly (ControlRecord | null)[],
  index: number,
  record: Extract<ControlRecord, { kind: 'foreach' }>,
  verdict: GuardVerdict,
  state: ControlState,
): ControlPlan {
  let cursor = state.cursors.get(index);

  if (verdict.kind === 'list') {
    // Entering the loop. A run resumed inside the body counts its partial
    // pass as pass 1, so the list is entered one element further on.
    const startAt = cursor?.resumed ? 1 : 0;
    cursor = {
      items: [...verdict.items],
      ...(verdict.properties && { properties: [...verdict.properties] }),
      index: startAt,
      resumed: cursor?.resumed ?? false,
    };
    state.cursors.set(index, cursor);
  } else if (cursor && cursor.items !== null) {
    cursor = { ...cursor, index: cursor.index + 1 };
    state.cursors.set(index, cursor);
  } else {
    // A `resume` verdict with no list read yet — a caller bug rather than an
    // author's. Treat it as an empty list so the run continues past the loop.
    cursor = { items: [], index: 0, resumed: false };
    state.cursors.set(index, cursor);
  }

  const items = cursor.items ?? [];
  if (cursor.index >= items.length) {
    const count = items.length;
    // A `For each` over an empty list: the guard decided, and every body step
    // is skipped. Once at least one pass has run there is nothing to skip.
    const ranBefore = cursor.index > 0;
    return {
      skip: ranBefore ? [] : [[record.bodyStart, record.bodyEnd]],
      next: exitFrom(controls, record.bodyEnd, index),
      loopEnded: { guard: index, count },
    };
  }

  state.passes.set(index, cursor.index + 1);
  resetNestedState(controls, record, state);
  return {
    skip: [],
    next: record.bodyStart,
    pass: {
      iteration: cursor.index + 1,
      count: items.length,
      bindings: passBindings(record.item, items[cursor.index]!, cursor.properties?.[cursor.index]),
    },
  };
}

/**
 * What one pass writes into the live variable map: the base name, plus one
 * dotted key per direct property of an object item
 * (docs/specs/SPEC-structured-table-reads.md §8.2).
 *
 * The base binding is unchanged — an object still binds `{{order}}` to its
 * compact JSON text, which is what a scalar `For each` over a JSON array of
 * objects already did and what a step printing the whole row still wants.
 *
 * Base FIRST, so a record with a property literally called `order` under an
 * item called `order` cannot shadow the item itself... which it cannot anyway,
 * since a property's key is always `order.something`. The order is for the
 * Variables panel, which renders insertion order and should lead with the row.
 *
 * Nothing is snapshotted or restored: the last pass's bindings, dotted ones
 * included, stay in the one live map after the loop, exactly as the scalar
 * binding always has (§8.2, last paragraph).
 */
function passBindings(
  item: string,
  value: string,
  properties: Record<string, string> | undefined,
): Record<string, string> {
  const bindings: Record<string, string> = { [item]: value };
  for (const [key, text] of Object.entries(properties ?? {})) {
    bindings[`${item}.${key}`] = text;
  }
  return bindings;
}

function planConditionLoop(
  controls: readonly (ControlRecord | null)[],
  index: number,
  record: Extract<ControlRecord, { kind: 'while' | 'repeat' }>,
  verdict: GuardVerdict,
  state: ControlState,
): ControlPlan {
  const passes = state.passes.get(index) ?? 0;
  const cap = record.cap ?? state.defaultCap;
  const capSource: 'line' | 'config' = record.cap === undefined ? 'config' : 'line';

  // `Repeat`'s first pass: no question was asked, the body simply runs.
  if (record.kind === 'repeat' && verdict.kind === 'resume') {
    state.passes.set(index, passes + 1);
    resetNestedState(controls, record, state);
    return { skip: [], next: record.bodyStart, pass: { iteration: passes + 1 } };
  }

  const holds = verdict.kind === 'condition' ? verdict.holds : false;
  // `While` runs while the condition holds; `Repeat … until` stops when it
  // does. One flag, opposite senses, so the rest of this function is shared.
  const carryOn = record.kind === 'while' ? holds : !holds;

  if (!carryOn) {
    return {
      // A `While` whose condition was false the first time never runs its
      // tail, so the tail's steps are skipped. Anything that already ran is
      // not re-marked.
      skip: passes === 0 ? [[record.bodyStart, record.bodyEnd]] : [],
      next: exitFrom(controls, record.bodyEnd, index),
      loopEnded: { guard: index, count: passes },
    };
  }

  if (passes >= cap) {
    // Reaching the cap with the exit condition unmet FAILS the loop line. It
    // has not done what the author asked, so exiting quietly would be a green
    // run on an unfinished job (decision 9).
    return {
      skip: [],
      next: exitFrom(controls, record.bodyEnd, index),
      capBreached: { cap, source: capSource },
    };
  }

  state.passes.set(index, passes + 1);
  resetNestedState(controls, record, state);
  return { skip: [], next: record.bodyStart, pass: { iteration: passes + 1 } };
}

/**
 * Step `index` just finished. If it closes a loop body, where next?
 *
 * Null when nothing special applies and the caller should continue at
 * `index + 1`. The walk goes INNERMOST outward: a loop nested inside a chain
 * member's body, both ending on the same step, must re-enter its own guard
 * rather than leave the chain.
 */
export function planAfterStep(
  controls: readonly (ControlRecord | null)[],
  index: number,
  _state: ControlState,
): { next: number; reevaluate?: number } | null {
  if (innermostClosing(controls, index, controls.length) === -1) return null;
  return walkOut(controls, index, controls.length);
}

/**
 * The innermost guard, BELOW `below`, whose body ends at `end` — or -1.
 *
 * "Innermost" is the highest index: a guard nested inside another's body sits
 * after it in the flat list, so of two guards closing on the same step the
 * later one is the inner one. `below` is how a walk excludes the structure it
 * is leaving (and everything nested inside it, which is always after it).
 */
function innermostClosing(
  controls: readonly (ControlRecord | null)[],
  end: number,
  below: number,
): number {
  let inner = -1;
  for (let g = 0; g < below && g < controls.length; g++) {
    if (controls[g]?.bodyEnd === end) inner = g;
  }
  return inner;
}

/**
 * Walk outward from a structure that has just ended, and say where the run
 * goes.
 *
 * The one rule, applied repeatedly: if a LOOP's body ends where we are, that
 * loop's pass has ended and the run goes back to its guard; if a CHAIN
 * member's body ends here, the whole chain is done and the walk continues from
 * the chain's end; if nothing encloses us, the run continues at the next step.
 *
 * Every hop moves strictly outward — to a guard with a smaller index — so the
 * loop is bounded by the number of records.
 */
function walkOut(
  controls: readonly (ControlRecord | null)[],
  endIndex: number,
  below: number,
): { next: number; reevaluate?: number } {
  let end = endIndex;
  let limit = below;
  for (let hop = 0; hop <= controls.length; hop++) {
    const inner = innermostClosing(controls, end, limit);
    if (inner === -1) return { next: end + 1 };
    const record = controls[inner]!;
    // A loop pass has ended. Everything outside is still mid-body, so the walk
    // stops here and the loop re-evaluates.
    if (!isChainRecord(record)) return { next: inner, reevaluate: inner };
    // A chain ends at its LAST member's body, which can be further on than the
    // member we came out of; the walk continues from there.
    end = Math.max(end, record.chainEnd);
    limit = inner;
  }
  return { next: end + 1 };
}

/**
 * Where the run goes when the structure `selfGuard` opens has just ended at
 * `endIndex` — a loop's `bodyEnd`, or a chain's `chainEnd`.
 *
 * Every exit a guard's own plan can take goes through here: a chain that
 * selected nothing, a `For each` whose list is exhausted, a `While` / `Repeat`
 * whose condition ended it, and a cap breach. `bodyEnd + 1` is right only at
 * the top level; inside anything it walks OUT of the structure that contains
 * the guard, and all three of these shapes are reachable and were silent:
 *
 *  - an inner chain that selects nothing, as the last step of an outer chain
 *    member, resumed at the outer chain's NEXT member — so both branches of
 *    one decision ran, one of them already reported skipped;
 *  - a section whose last step is a `While`, called from another loop's body:
 *    the outer loop ran exactly one pass;
 *  - a chain member's body ending in a loop: `bodyEnd + 1` is the next
 *    member's guard, so the run evaluated an `Otherwise` it had already
 *    decided against.
 *
 * `selfGuard` excludes the guard that is exiting — and with it everything
 * nested inside, which always sits at a higher index.
 */
export function exitFrom(
  controls: readonly (ControlRecord | null)[],
  endIndex: number,
  selfGuard: number,
): number {
  return walkOut(controls, endIndex, selfGuard).next;
}

/**
 * Where a `return` / `stop` at expanded index `i` actually lands once the
 * control structures around it are taken into account
 * (stories/control-flow.md §"Composition with `If … then return`";
 * stories/step-flow-control.md decision 1).
 *
 * The two features answer the same question from opposite ends and both are
 * right about their half. `frameExitIndex` (src/runner/flow-control.ts) knows
 * about FRAMES — a section body, a skill body, the main flow — and says which
 * later steps belong to the flow being left. It knows nothing about the
 * control records, so from inside a loop body it happily hands back the last
 * index of the *test*. The other feature's rule is that "a return never breaks
 * out of a loop; it leaves the flow it is in, and an iteration is a flow", so
 * that answer is one flow too many.
 *
 * This is the whole reconciliation, in two parts:
 *
 *  - `exit` is the frame's answer CLAMPED to the innermost control body that
 *    contains `i`. Inside a loop body that is the body's last index, so the
 *    pass ends and nothing beyond it is reported skipped. Inside a chain
 *    member's body it is that member's last index — the untaken members were
 *    already skipped by the decision itself, and re-reporting them here would
 *    file a second skipped row for each.
 *  - `enclosed` says whether a clamp was possible at all, and it is what the
 *    caller must consult before running `planAfterStep` on `exit`. Inside a
 *    body, `planAfterStep(exit)` is exactly right: it sends a loop back to its
 *    guard and walks a chain out to `chainEnd + 1`. In the MAIN flow it is
 *    exactly wrong — a main-flow return ends the run, and if the test's last
 *    expanded step happens to close a loop body then `planAfterStep` would
 *    read that as "a pass just ended" and jump the run back INTO the loop it
 *    had just declared skipped.
 *
 * A return from a skill called inside a loop body gets `exit` from the frame
 * (the skill's last step, well short of the body's end) and `enclosed: true`,
 * so the run resumes after the call with the pass still going. That falls out
 * of the `Math.min` rather than needing a case of its own.
 */
export function returnExit(
  controls: readonly (ControlRecord | null)[],
  i: number,
  frameExit: number,
): { exit: number; enclosed: boolean } {
  // Innermost is the HIGHEST guard index whose body contains `i`: a structure
  // nested inside another's body always sits after it in the flat list.
  let inner: ControlRecord | null = null;
  for (let g = 0; g < controls.length && g <= i; g++) {
    const record = controls[g];
    if (!record) continue;
    if (record.bodyStart <= i && i <= record.bodyEnd) inner = record;
  }
  if (!inner) return { exit: frameExit, enclosed: false };
  return { exit: Math.min(frameExit, inner.bodyEnd), enclosed: true };
}

/**
 * A loop pass is starting: forget where every structure INSIDE its body got to.
 *
 * Pass counters and `For each` cursors are keyed by guard index, and the flat
 * list does not grow when a loop runs again — so a `While` nested in another
 * loop's body would carry its previous pass's counter into the new one, hit its
 * cap on the outer loop's third pass, and fail a line that had done nothing
 * wrong. A `For each` inside a loop is worse still: its cursor is already past
 * the end of the list, so on the outer loop's second pass it runs no items at
 * all and marks nothing skipped. Each pass of the outer loop is a fresh visit
 * to everything it contains.
 *
 * Called by the planner itself, on every plan that starts a pass — exported
 * because a caller rebuilding a state by hand wants the same rule.
 */
export function resetNestedState(
  controls: readonly (ControlRecord | null)[],
  record: ControlRecord,
  state: ControlState,
): void {
  for (let g = record.bodyStart; g <= record.bodyEnd && g < controls.length; g++) {
    if (!controls[g]) continue;
    state.passes.delete(g);
    state.cursors.delete(g);
  }
}

/**
 * A run starting at `startIndex`: which guards count as taken?
 *
 * A `startAt` landing inside a tail is an author clicking a line inside
 * `Pay by card`, so that tail's guard is treated as taken and the chain's
 * other members — with their tails — are skipped. Landing inside a loop body
 * completes the pass and continues from the guard as normal, with the pass
 * number restarting at 1 because the count lived in the batch that was paused.
 *
 * Seeds `state`, which is why it takes one (the story's signature did not).
 * Ranges that lie entirely BEFORE `startIndex` are dropped: those steps are
 * outside the batch, and the bounded-run machinery already accounts for them.
 */
export function planForStart(
  controls: readonly (ControlRecord | null)[],
  startIndex: number,
  state: ControlState,
): ControlPlan {
  const skip: Array<[number, number]> = [];

  for (let g = 0; g < controls.length; g++) {
    const record = controls[g];
    if (!record) continue;
    if (startIndex < record.bodyStart || startIndex > record.bodyEnd) continue;

    if (isChainRecord(record)) {
      for (const j of chainMembers(controls, g)) {
        if (j === g) continue;
        const sibling = controls[j] as ChainRecord;
        if (sibling.bodyEnd < startIndex) continue;
        skip.push([j, sibling.bodyEnd]);
      }
      continue;
    }

    // SEEDED, not set. The server calls this once, at `startAt`, against an
    // empty state — where the two are the same thing. The Runner UI's
    // debugger calls it on every jump-to-step, and a jump into a body the run
    // has already been through would reset the counter to 1: four passes
    // banded `1/3, 2/3, 2/3, 3/3`, one number repeated and one pass never
    // counted (review 3, finding 3). "This loop has run at least one pass" is
    // all this line ever meant to say.
    if (record.kind === 'foreach') {
      // SEEDED too, for the same reason and by the same rule. Resetting the
      // cursor made the counter's `Math.max` a no-op for this kind: the next
      // visit finds `items === null`, asks for the list again, and
      // `planForEach` SETS the pass count from the fresh cursor — so a second
      // jump into a `For each` body replayed a band and lost a pass
      // (`1/4, 2/4, 2/4, 3/4, 4/4` for a four-item list; review 4, finding 4).
      // Keeping the items also keeps the list the loop is iterating: re-reading
      // it lets a capture made inside the body change the bound of the loop it
      // is inside, which is the thing `planAtGuard` refuses to do on an
      // ordinary pass.
      const cursor = state.cursors.get(g);
      state.cursors.set(g, {
        items: cursor?.items ?? null,
        index: cursor?.index ?? 0,
        resumed: true,
      });
    }
    state.passes.set(g, Math.max(state.passes.get(g) ?? 0, 1));
  }

  return { skip: mergeRanges(skip), next: startIndex };
}

/**
 * Where a run whose `endAt` lands on `endIndex` should actually stop.
 *
 * A guard evaluated with its body sliced away is a decision with no
 * consequence, so *Run Step Here* on one runs the structure it opens: a
 * chain's `chainEnd`, a loop's `bodyEnd`. Idempotent for any index that is not
 * a guard, which is every ordinary step.
 */
export function snapEndAt(
  controls: readonly (ControlRecord | null)[],
  endIndex: number,
): number {
  let end = endIndex;
  // Bounded rather than `while (true)`: a body's last step can never itself be
  // a guard (a guard's tail follows it, so its span would extend past the
  // body's end), so one hop is enough — the loop is belt and braces against a
  // malformed records array, not an expected shape.
  for (let hop = 0; hop < controls.length; hop++) {
    const record = controls[end];
    if (!record) break;
    const target = isChainRecord(record) ? record.chainEnd : record.bodyEnd;
    if (target <= end) break;
    end = target;
  }
  return end;
}

/**
 * The first loop guard whose STRUCTURE overlaps `[startIndex, endIndex]`, or
 * undefined when the slice touches none.
 *
 * A loop's structure is its guard plus its body — the indices the run can
 * visit more than once — so a compile bounded to a step outside every one of
 * them writes exactly one entry per step and is safe, while one that includes
 * a guard or any of its body is not (see {@link loopCompileRefusal}).
 *
 * A whole-file compile passes the whole range and gets the file-wide answer,
 * which is what the CLI wants: it has no way to bound a compile at all.
 */
export function firstLoopInRange(
  controls: readonly (ControlRecord | null)[],
  startIndex: number,
  endIndex: number,
): number | undefined {
  for (let i = 0; i < controls.length; i++) {
    const record = controls[i];
    if (!record) continue;
    if (record.kind !== 'while' && record.kind !== 'repeat' && record.kind !== 'foreach') continue;
    if (i <= endIndex && record.bodyEnd >= startIndex) return i;
  }
  return undefined;
}

/**
 * Why a compile that reaches into a loop is refused, in one wording shared by
 * the CLI's compile and the server's (stories/control-flow.md, decision 12).
 *
 * A compile places an entry at `spans[occurrence]`, and occurrence is counted
 * per step line — but a loop body runs the same lines a number of times only
 * the page decides, so the run offers several transcripts for one slot and the
 * plan's "not attempted" arithmetic counts a step that ran three times as one.
 *
 * The advice names things the author can actually do, which the first version
 * of this sentence did not: it said "compile the section the loop runs, on its
 * own" while refusing on the whole FILE, so that compile was refused too.
 */
export function loopCompileRefusal(guardLine: string): string {
  return (
    `"${guardLine}" runs its step a number of times the page decides, and a compile ` +
    'cannot write one entry for a step that ran several times with different values. ' +
    'What still works: Compile This Step on a step OUTSIDE the loop, and Compile This ' +
    'Step on the body of the section the loop runs — a section body compiles on its ' +
    'own, once. Or remove the loop before compiling.'
  );
}

/**
 * Which item of the innermost live `For each` binding `item` is running — the
 * number `{{order.statuz}} has no value in For each item 2` names
 * (docs/specs/SPEC-structured-table-reads.md §8.3).
 *
 * Innermost is the HIGHEST guard index, the same rule the rest of this module
 * uses: a loop nested inside another's body sits after it in the flat list. A
 * `For each` that has not started a pass yet, and a name no loop binds, both
 * answer undefined, and the caller's message leaves the clause out.
 *
 * Reads the state the planner already keeps rather than adding a field to it,
 * so nothing has to be threaded through the three run loops to ask.
 */
export function forEachPassOf(
  controls: readonly (ControlRecord | null)[],
  state: ControlState,
  item: string,
): number | undefined {
  for (let g = controls.length - 1; g >= 0; g--) {
    const record = controls[g];
    if (!record || record.kind !== 'foreach' || record.item !== item) continue;
    const passes = state.passes.get(g);
    if (passes !== undefined) return passes;
  }
  return undefined;
}

/**
 * A property name safe to expose as `{{item.property}}`: the spec's identifier
 * rule (§8.2), which is also what an alias must satisfy at the other end
 * (§4.1).
 */
const SAFE_PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The three names that are not data. `__proto__` on a plain object literal
 *  from `JSON.parse` is an own property rather than the setter, but a binding
 *  named after one of these travels into maps that are not — and a variable
 *  called `constructor` is a trap wherever it lands. */
const DANGEROUS_PROPERTIES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/**
 * Validate what `{{list}}` holds for a `For each`, and bind its elements.
 *
 * A JSON array and nothing else (decision 10): a list that came from a `Set`
 * is text, and guessing a delimiter is how a value with a comma in it
 * silently becomes two. A non-string element is bound as its JSON text.
 *
 * An OBJECT element binds that JSON text too — unchanged, because that is what
 * a step printing the whole row reads — and, in addition, one dotted binding
 * per direct property (docs/specs/SPEC-structured-table-reads.md §8.2). The
 * per-property conversion is the spec's: a string travels unchanged, a number
 * or boolean becomes its JSON lexical form, `null` becomes the four characters
 * `null`, and a nested object or array becomes compact JSON. Nothing is
 * flattened recursively — one property segment is all v1 addresses.
 *
 * A key that is not a safe identifier, or is one of the three prototype names,
 * FAILS the guard naming the one-based item index, and binds nothing at all.
 * Partial bindings are the failure mode this rule exists for: a loop that
 * silently dropped `order.id` would run every pass against an empty string.
 */
export function parseListValue(
  name: string,
  raw: string | undefined,
): { items: string[]; properties: Array<Record<string, string> | undefined> } | { error: string } {
  if (raw === undefined) {
    return {
      error:
        `\`{{${name}}}\` has no value, so there is nothing to loop over — ` +
        `capture it first with a read of every matching element, or with a ` +
        `tool that returns an array.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: notAList(name, raw) };
  }
  if (!Array.isArray(parsed)) return { error: notAList(name, raw) };

  const items: string[] = [];
  const properties: Array<Record<string, string> | undefined> = [];
  for (const [i, element] of parsed.entries()) {
    items.push(typeof element === 'string' ? element : JSON.stringify(element));
    if (!isPlainRecord(element)) {
      properties.push(undefined);
      continue;
    }
    const fields: Record<string, string> = {};
    for (const key of Object.keys(element)) {
      const refusal = unsafePropertyReason(key);
      if (refusal !== undefined) {
        return {
          error:
            `\`{{${name}}}\` item ${i + 1} has a property named \`${key}\`, which ` +
            `${refusal}. Every property becomes a \`{{item.property}}\` binding, so ` +
            `rename it — the read step's \`… as <alias>\`, or the field the tool returns.`,
        };
      }
      fields[key] = propertyText((element as Record<string, unknown>)[key]);
    }
    properties.push(fields);
  }

  return { items, properties };
}

/** A JSON object — not an array, not null, and not something `JSON.parse`
 *  cannot produce. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a record's key cannot become a dotted binding, or undefined. */
function unsafePropertyReason(key: string): string | undefined {
  if (DANGEROUS_PROPERTIES.has(key)) return 'is a reserved JavaScript name';
  if (!SAFE_PROPERTY.test(key)) {
    return 'is not a name a placeholder can spell (letters, digits and underscores, not starting with a digit)';
  }
  return undefined;
}

/** One property value as the text its `{{item.property}}` binding holds
 *  (§8.2). */
function propertyText(value: unknown): string {
  if (typeof value === 'string') return value;
  // `JSON.stringify(undefined)` is `undefined`, not a string — unreachable for
  // a parsed document, since JSON has no `undefined`, but the cast below would
  // hide it rather than the map holding the four characters `null`.
  return value === undefined ? 'null' : JSON.stringify(value);
}

function notAList(name: string, raw: string): string {
  const shown = raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
  return (
    `\`{{${name}}}\` holds \`${shown}\`, not a list — capture it with a read ` +
    `of every matching element, or a tool that returns an array.`
  );
}

/** Sort and coalesce inclusive ranges; adjacent ranges merge, so a chain's
 *  consecutive skipped members read as one span. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
