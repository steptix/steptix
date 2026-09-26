/**
 * The impure half of control flow: what the three run loops share
 * (stories/control-flow.md §Runtime).
 *
 * [control-flow.ts](control-flow.ts) is the pure planner — it decides what to
 * skip and where to go next, and knows nothing about pages, models or step
 * results. This module is the layer immediately above it: it obtains the
 * verdict the planner asks for (one variable read, a code-behind `condition`,
 * or one model call — in that order), turns a failed guard into the sentence
 * the author reads, and tracks which loop pass is running so a result can be
 * stamped with its band.
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
  capBreachAt,
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
import { decideConditionLocally, localReasoning, type LocalDecision } from './literal-decision.js';
import { clearDottedKeys, placeholderRoot } from '../parser/parameters.js';
import {
  boundValue,
  dottedReferenceError,
  type PlaceholderValues,
} from './placeholder-substitution.js';
import { redact, runSecrets } from '../utils/secrets.js';
import { markLoopBindings } from '../utils/loop-bindings.js';
import { logger } from '../utils/logger.js';
import {
  evaluateConditions,
  runConditionCode,
  settleBeforeConditions,
  KEYLESS_HEAL_SKIPPED_ERROR,
  POLICY_HEAL_SKIPPED_ERROR,
} from './step-executor.js';
import type { ConditionVerdict, StepExecutorOptions } from './step-executor.js';
import { warnBindingOnce, type CodeBehindBinding } from '../codebehind/loader.js';
import { entrySourceText, isConditionCode, isStepCode } from '../codebehind/execute.js';
import type { StepCodeEntry } from '../codebehind/types.js';
import type { CapturedLog } from '../tools/step-api.js';

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

/** A guard row's structured decision — `StepResult.guard`. */
export type GuardDecision = NonNullable<StepResult['guard']>;

/**
 * What a run loop hands `evaluateGuard` so a condition can be decided by its
 * code-behind (stories/codebehind-loops-and-conditions.md, "The guard").
 *
 * The same registry, strict flag and keyless flags the run's steps get. Omitted
 * entirely when code-behind is off for the run (`compile: 'steps'`, a Record,
 * `codeBehindOff`), which leaves every guard on today's path.
 */
export interface GuardCodeBehind {
  /** The binding for an absolute 0-based expanded index — a chain member's
   *  or a loop guard's own. */
  bindingFor(index: number): CodeBehindBinding | undefined;
  /** A compile replay: a condition entry that breaks fails the guard rather
   *  than being re-decided by the model. */
  strict?: boolean | undefined;
  /** No model to heal with: a condition entry that breaks fails the guard with
   *  the same advice a broken step gets. */
  keyless?: boolean | undefined;
  /** Which advice: no key on this machine, or AI forbidden by policy. */
  keylessReason?: StepExecutorOptions['keylessReason'];
  /** A compiling run: keep the page the model decided on
   *  (`GuardDecision.evidence`). */
  captureEvidence?: boolean | undefined;
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
  /** Who decided and why, in a sentence: the model's words, the values'
   *  `decided from the values: …`, or `Decided by code-behind: …`. */
  reasoning?: string;
  /** Every judge turn, so a guard's cost is as visible as a step's. */
  aiInteractions: AiInteraction[];
  /** The guard itself failed: a cap breach, a `For each` over a non-list, a
   *  judge that could not decide, or a condition entry that failed for real.
   *  The caller fails the guard and stops. */
  error?: string;
  durationMs: number;
  /**
   * The decision was made by code-behind `condition` entries — every member
   * asked was answered by its entry or its own values, and at least one by an
   * entry. Rendered with the code mark, exactly as on a step.
   */
  fromCodeBehind?: boolean;
  /**
   * The condition code that ran on this visit. `file` is the last member's to
   * run (the one that decided, or the one that failed); `code` is that
   * entry's function, or — when several members' code ran — each member's
   * function under a `// <source>` line, in the order they ran; `logs` are all
   * of their logs, in order.
   */
  codeBehind?: NonNullable<StepResult['codeBehind']>;
  /** A condition entry broke and the model decided in its place. It names the
   *  member whose code broke — see `guard.staleMember` for its index. */
  codeBehindStale?: NonNullable<StepResult['codeBehindStale']>;
  /** A condition entry broke and there was no model to decide in its place
   *  (a keyless or policy-off run): the guard failed. */
  codeBehindHealSkipped?: NonNullable<StepResult['codeBehindHealSkipped']>;
  /** With `error`: a condition entry called `step.fail(...)` — the author's
   *  own failure (`StepResult.deliberate`), worded as theirs everywhere. */
  deliberate?: boolean;
  /**
   * The structured decision (stories/codebehind-loops-and-conditions.md).
   * Present on every `chain` / `condition` visit that decided, or whose
   * condition code failed; absent on a `For each` (`list`) visit, on a visit
   * that asks nobody, and on a failure before any decision (a dotted refusal,
   * a judge that could not decide).
   */
  guard?: GuardDecision;
}

/**
 * Visit the guard at `index`: ask whatever the planner needs asked, then plan.
 *
 * The one impure step in the whole feature. Everything it can go wrong with
 * comes back as {@link GuardEvaluation.error} — except an abort, which is
 * rethrown so the caller can end the run as 'aborted' rather than 'failed'
 * (issues/020's rule, applied to the judge as it already is to the watch).
 *
 * A chain or a loop condition is answered in a fixed order
 * (stories/codebehind-loops-and-conditions.md, decisions 5–8): its own values
 * (`decideLocally`, unchanged), then its code-behind `condition` entries —
 * only when EVERY member asked is answerable without a model, after the page
 * settles — then the judge. A condition entry that breaks is discarded and
 * the judge decides the whole question; a loop whose code says "carry on" at
 * its cap is checked with the judge once before the planner is consulted, so
 * the planner is advanced exactly once, on the answer that stands.
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
  /**
   * The run's code-behind, so a condition with a `condition` entry is decided
   * by it (stories/codebehind-loops-and-conditions.md, decisions 5–8). Omitted
   * when code-behind is off for the run — and by the Electron adapter, which
   * runs no code-behind for any line (decision 16).
   */
  codeBehind?: GuardCodeBehind | undefined;
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
  /**
   * Everything this visit learned about code-behind, gathered as it goes so
   * that every exit below — a decision, a guard error, and the catch — carries
   * it. A condition entry that threw and was discarded must reach the row even
   * when the model it fell through to could not decide either.
   */
  const code: CodeFacts = {};
  /** The note a cap breach carries when code decided the passes (decision 8). */
  let capNote: string | undefined;

  try {
    switch (request.ask) {
      case 'chain':
      case 'condition': {
        const asked =
          request.ask === 'chain'
            ? request.conditions
            : [{ index, condition: request.condition }];
        const decided = await decideCondition({
          asked,
          values,
          redactText,
          executorOptions,
          codeBehind: args.codeBehind,
          code,
        });
        if (decided.error !== undefined) {
          // A condition entry failed for real — `step.expect`, `step.fail`, a
          // refused `step.exit()`, a file that is not there — or it broke on a
          // run that cannot heal it. Either way nothing decided, so there is
          // no plan to make: the guard fails where it stands.
          return {
            plan: { skip: [], next: exitFailed(controls, index) },
            evaluated: true,
            ...(decided.reasoning !== undefined && { reasoning: decided.reasoning }),
            aiInteractions: [],
            error: decided.error,
            // `step.fail(...)`: the author's own failure, carried as the step
            // path carries it, so every surface words it as theirs rather than
            // as a code-behind defect.
            ...(decided.deliberate && { deliberate: true }),
            durationMs: Date.now() - startedAt,
            ...codeFields(code),
            guard: {
              decidedBy: 'code',
              ...staleMemberOf(code),
              // Which member's code failed: the row belongs to the member the
              // visit was asked from, and a chain's failing member is otherwise
              // lost — what the boxed compile's replay blames and repairs.
              ...(decided.failedMember !== undefined && { failedMember: decided.failedMember }),
            },
          };
        }
        reasoning = decided.reasoning;
        aiInteractions = decided.aiInteractions;
        let selected = decided.selected;
        let decision: GuardDecision;

        if (request.ask === 'condition') {
          let holds = selected === 0;
          // Decision 8 — the one wrong answer a run can catch by itself. Code
          // that keeps saying "carry on" reaches the cap; before the planner
          // turns that into a failure, the model is asked once whether the
          // condition really still holds. Asked HERE, before `planAfterGuard`,
          // so the planner's pass count is advanced exactly once, on the
          // answer that stands.
          const record = controls[index];
          const breach = capBreachAt(controls, index, state);
          const carryOn = record?.kind === 'repeat' ? !holds : holds;
          if (decided.decidedBy === 'code' && carryOn && breach) {
            const net = await checkCapWithModel({
              condition: request.condition,
              kind: record?.kind === 'repeat' ? 'repeat' : 'while',
              holds,
              passes: breach.passes,
              binding: args.codeBehind?.bindingFor(index),
              index,
              executorOptions,
              codeBehind: args.codeBehind,
              code,
            });
            capNote = net.capNote;
            if (net.judged) {
              aiInteractions = [...aiInteractions, ...net.judged.aiInteractions];
              if (net.disagreed) {
                // The model's answer stands; the loop ends where it says.
                holds = !holds;
                selected = holds ? 0 : null;
                reasoning = net.judged.reasoning;
                decided.decidedBy = 'model';
              }
              decided.evidence = net.judged.evidence;
            }
          }
          decision = { decidedBy: decided.decidedBy, holds };
          verdict = { kind: 'condition', holds };
        } else {
          // Back to ABSOLUTE indices: the judge answered about a list the
          // planner built, and the planner reads step positions. `null` stays
          // null — the planner turns "none" into the `Otherwise` itself.
          const absolute =
            selected === null ? null : (request.conditions[selected]?.index ?? null);
          decision = { decidedBy: decided.decidedBy, selected: absolute };
          verdict = { kind: 'chain', selected: absolute };
        }

        Object.assign(decision, staleMemberOf(code));
        // Only a compiling run keeps the page, and only when the model
        // decided (or confirmed, at a cap) — code and values need no evidence
        // to be generated from (decision 9).
        if (args.codeBehind?.captureEvidence && decided.evidence) {
          decision.evidence = {
            ...decided.evidence,
            members: asked.map((member, position) =>
              selected === null || position < selected
                ? { index: member.index, holds: false }
                : position === selected
                  ? { index: member.index, holds: true }
                  : { index: member.index },
            ),
          };
          // A loop condition's one member holds as written — which for a
          // `Repeat … until` that carries on is `false`, and the map above
          // already says so: `selected` is 0 exactly when it held.
        }
        code.decision = decision;
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
      // A condition entry that broke on the way here was discarded and is
      // still stale, even though the model it fell through to could not
      // decide either — the row must say so, or `--only-stale` never finds it.
      ...codeFields(code),
      ...(code.stale !== undefined && {
        guard: { decidedBy: 'model' as const, ...staleMemberOf(code) },
      }),
    };
  }

  const plan = planAfterGuard(controls, index, verdict, state);
  const record = controls[index];
  const capError =
    plan.capBreached && record && isLoopRecord(record)
      ? capBreachMessage(record, plan.capBreached) + (capNote ?? '')
      : undefined;
  return {
    plan,
    evaluated: request.ask !== 'nothing',
    ...(reasoning !== undefined && { reasoning }),
    aiInteractions,
    ...(capError !== undefined && { error: capError }),
    durationMs: Date.now() - startedAt,
    ...codeFields(code),
    ...(code.decision !== undefined && { guard: code.decision }),
  };
}

/**
 * What a guard visit learned about code-behind, accumulated across the
 * helpers that decide it. See `evaluateGuard`'s `code`.
 */
interface CodeFacts {
  /** Condition entries that ran, in order, captured BEFORE any discard. */
  ran?: Array<{ binding: CodeBehindBinding; entry: StepCodeEntry; logs: CapturedLog[] }>;
  /** Code decided (or failed) the guard — the row carries the code mark. */
  fromCodeBehind?: boolean;
  /** An entry broke and the model decided in its place. */
  stale?: { index: number; file: string; source: string; error: string };
  /** An entry broke and nothing could decide in its place. */
  healSkipped?: { index: number; file: string; source: string; error: string };
  decision?: GuardDecision;
}

/** The `GuardEvaluation` fields {@link CodeFacts} stands for. */
function codeFields(
  code: CodeFacts,
): Pick<GuardEvaluation, 'fromCodeBehind' | 'codeBehind' | 'codeBehindStale' | 'codeBehindHealSkipped'> {
  const ran = code.ran ?? [];
  const last = ran[ran.length - 1];
  return {
    ...(code.fromCodeBehind && { fromCodeBehind: true }),
    // The code block rides only a row the code decided or failed, as on a
    // step: a healed row shows the model's turns, and the stale flag says
    // what the entry threw.
    ...(code.fromCodeBehind &&
      last && {
        codeBehind: {
          file: last.binding.file,
          code:
            ran.length === 1
              ? entrySourceText(last.entry)
              : ran
                  .map((r) => `// ${r.binding.source}\n${entrySourceText(r.entry)}`)
                  .join('\n\n'),
          logs: ran.flatMap((r) => r.logs),
        },
      }),
    ...(code.stale && {
      codeBehindStale: { file: code.stale.file, source: code.stale.source, error: code.stale.error },
    }),
    ...(code.healSkipped && {
      codeBehindHealSkipped: {
        file: code.healSkipped.file,
        source: code.healSkipped.source,
        error: code.healSkipped.error,
      },
    }),
  };
}

/** `{ staleMember }` when an entry broke on this visit, else nothing. */
function staleMemberOf(code: CodeFacts): { staleMember?: number } {
  const broken = code.stale ?? code.healSkipped;
  return broken ? { staleMember: broken.index } : {};
}

/** One member of the question a guard visit asks: its absolute index and its
 *  AUTHORED condition text. */
interface AskedMember {
  index: number;
  condition: string;
}

/** What {@link decideCondition} settled on. `selected` indexes `asked`. */
interface ConditionDecision {
  selected: number | null;
  reasoning?: string;
  aiInteractions: AiInteraction[];
  decidedBy: GuardDecision['decidedBy'];
  /** The page the judge decided on, when the judge decided. */
  evidence?: { dom: string; url: string } | undefined;
  /** Set when a condition entry failed and nothing decided — the guard fails. */
  error?: string;
  /** With `error` on the code path: the absolute index of the member whose
   *  code failed (`GuardDecision.failedMember`). */
  failedMember?: number;
  /** With `error`: the entry called `step.fail(...)` — the author's failure. */
  deliberate?: boolean;
}

/**
 * Decide a chain or a loop condition: values, then code, then the model
 * (stories/codebehind-loops-and-conditions.md, decision 5).
 *
 * `decideLocally` first, untouched — a condition decided from its own values is
 * exact and free. Then the code path, which answers only when EVERY member
 * asked can be answered without a model (its values, or its entry); otherwise
 * the whole question goes to the judge exactly as before this existed. A
 * condition entry that breaks is discarded and the judge is asked about the
 * whole chain (decision 7), so a heal is one decision too.
 */
async function decideCondition(args: {
  asked: readonly AskedMember[];
  values: PlaceholderValues;
  redactText: (text: string) => string;
  executorOptions: StepExecutorOptions;
  codeBehind: GuardCodeBehind | undefined;
  code: CodeFacts;
}): Promise<ConditionDecision> {
  const { asked, values, redactText, executorOptions, codeBehind, code } = args;
  const conditions = asked.map((c) => c.condition);

  const local = decideLocally(conditions, values, redactText);
  if (local) {
    return {
      selected: local.selected,
      reasoning: local.reasoning,
      aiInteractions: [],
      decidedBy: 'values',
    };
  }

  const plan = codeBehind ? codePlan(asked, codeBehind, values, redactText, executorOptions) : undefined;
  if (plan && codeBehind) {
    const outcome = await runCodePlan(asked, plan, executorOptions, redactText, code);
    if (outcome.kind === 'decided') {
      // Code decided only when an entry actually RAN. `If {{plan}} is "pro"`
      // holding ahead of an `Else if` with an entry is the values' decision,
      // and the code mark on it would claim code that never ran.
      if (outcome.ranCode) code.fromCodeBehind = true;
      return {
        selected: outcome.selected,
        reasoning: outcome.reasoning,
        aiInteractions: [],
        decidedBy: outcome.ranCode ? 'code' : 'values',
      };
    }
    if (outcome.kind === 'failed') {
      code.fromCodeBehind = true;
      return {
        selected: null,
        reasoning: outcome.reasoning,
        aiInteractions: [],
        decidedBy: 'code',
        error: outcome.error,
        failedMember: outcome.member.index,
        ...(outcome.deliberate && { deliberate: true }),
      };
    }

    // Broken code: a throw, or a value that is not a boolean.
    const { member, binding, error } = outcome;
    const broken = { index: member.index, file: binding.file, source: binding.source, error };
    if (codeBehind.strict) {
      // A compile replay: the point is to find out whether the code works on
      // its own, and a silent heal would make a red compile look green.
      code.fromCodeBehind = true;
      logger.error(`Condition "${member.condition}" FAILED (code-behind, strict): ${error}`);
      return {
        selected: null,
        reasoning:
          'The condition\'s code-behind entry threw and strict mode is on, so the ' +
          'condition was not decided by the model. This is a compile replay: the ' +
          'point is to find out whether the code works on its own.',
        aiInteractions: [],
        decidedBy: 'code',
        error: `the condition's code-behind threw: ${error}`,
        failedMember: member.index,
      };
    }
    if (codeBehind.keyless) {
      // The same skip, the same advice and the same structural flag a broken
      // STEP gets on a run with no model (runCodeBehindStep's keyless
      // branch): the error is the reader's next move, the thrown message is
      // in the explanation, and `codeBehindHealSkipped` is what the sidecar
      // writers turn into a stale row so the repair can find the entry.
      const byPolicy = codeBehind.keylessReason === 'policy';
      code.fromCodeBehind = true;
      code.healSkipped = broken;
      logger.error(
        `Condition "${member.condition}" FAILED (code-behind, ${byPolicy ? 'AI forbidden by policy' : 'no AI configured'}): ${error}`,
      );
      return {
        selected: null,
        reasoning:
          (byPolicy
            ? 'The condition\'s code-behind entry threw, and this run forbids AI ' +
              '(runSettings.ai: off, or ai.allowInRuns: false in aiui.config.json), ' +
              'so the condition was not decided by the model. '
            : 'The condition\'s code-behind entry threw, and this machine has no AI ' +
              'configured, so the condition was not decided by the model. ') +
          `The entry failed with: ${error}`,
        aiInteractions: [],
        decidedBy: 'code',
        error: byPolicy ? POLICY_HEAL_SKIPPED_ERROR : KEYLESS_HEAL_SKIPPED_ERROR,
      };
    }
    // Heal: discard the entry for the rest of the run — the registry hands out
    // this same binding on every visit, so pass 3 of a `While` whose code threw
    // on pass 2 goes straight to the model — and ask about the WHOLE chain.
    logger.warn(
      `Code-behind failed for condition "${member.condition}" — the model decides it: ${error}`,
    );
    binding.entry = undefined;
    code.stale = broken;
  }

  const judged = await evaluateConditions(conditions, executorOptions);
  return {
    selected: judged.selected,
    reasoning: judged.reasoning,
    aiInteractions: judged.aiInteractions,
    decidedBy: 'model',
    evidence: judged.evidence,
  };
}

/** How one member is answered on the code path: its own values, or its entry. */
type CodePlanItem = { literal: LocalDecision } | { binding: CodeBehindBinding };

/**
 * The code path's plan for this question, or undefined when it does not apply.
 *
 * It applies only when EVERY member can be answered without a model — the
 * literal rule's own all-or-nothing, for its reason: the judge is asked one
 * question about the whole chain, first-holds-wins, and answering half of it
 * elsewhere would be two decisions where the author wrote one. It also needs a
 * page to read, and never runs on the computer surface, where a condition
 * stays AI (decision 10).
 *
 * A `run` entry bound to a guard is in the wrong place — it acts, and a
 * condition answers — so it is warned about once and the model decides, with
 * nothing flagged stale.
 */
function codePlan(
  asked: readonly AskedMember[],
  codeBehind: GuardCodeBehind,
  values: PlaceholderValues,
  redactText: (text: string) => string,
  executorOptions: StepExecutorOptions,
): CodePlanItem[] | undefined {
  if (executorOptions.computer) return undefined;
  const plan: CodePlanItem[] = [];
  let answerable = true;
  let needsCode = false;
  for (const member of asked) {
    const binding = codeBehind.bindingFor(member.index);
    if (binding?.entry && isStepCode(binding.entry) && !isConditionCode(binding.entry)) {
      warnBindingOnce(
        binding,
        `Code-behind entry "${binding.source}" in ${binding.file} has a \`run\` function, ` +
          'but its line is a condition — a condition entry needs `condition`. The model decides it.',
      );
    }
    const literal = decideConditionLocally(member.condition, values, redactText);
    if (literal) {
      plan.push({ literal });
      continue;
    }
    if (binding && isConditionCode(binding.entry)) {
      plan.push({ binding });
      needsCode = true;
      continue;
    }
    answerable = false;
  }
  if (!answerable || !needsCode) return undefined;
  return activePage(executorOptions) ? plan : undefined;
}

/** The page a condition entry would read, or undefined when the run has none. */
function activePage(opts: StepExecutorOptions): StepExecutorOptions['page'] | undefined {
  try {
    return (opts.pageTracker ? opts.pageTracker.getActive() : opts.page) ?? undefined;
  } catch {
    return undefined;
  }
}

type CodePlanOutcome =
  | {
      kind: 'decided';
      selected: number | null;
      reasoning: string;
      /** Whether any entry actually ran. False when a member ahead of every
       *  entry held by its own values — the chain was decided by values, and
       *  says so (`decidedBy: 'values'`, no code mark). */
      ranCode: boolean;
    }
  | { kind: 'broken'; member: AskedMember; binding: CodeBehindBinding; error: string }
  | {
      kind: 'failed';
      member: AskedMember;
      error: string;
      reasoning: string;
      /** `step.fail(...)` — the author's failure, worded as theirs. */
      deliberate?: boolean;
    };

/**
 * Run the code path: answer each member in order — its values if it is
 * literal, else its entry — stopping at the first that holds. Members after it
 * are not run.
 *
 * The page is settled (decision 6) LAZILY, right before the first entry runs:
 * `If {{plan}} is "pro"` holding ahead of an `Else if` with an entry decides
 * the chain from its values alone, and waiting up to 10 s for a page nothing
 * reads is a cost with no question behind it.
 */
async function runCodePlan(
  asked: readonly AskedMember[],
  plan: readonly CodePlanItem[],
  executorOptions: StepExecutorOptions,
  redactText: (text: string) => string,
  code: CodeFacts,
): Promise<CodePlanOutcome> {
  const answers: Array<{ condition: string; holds: boolean; byValues: boolean }> = [];
  let ranCode = false;
  const decided = (selected: number | null): CodePlanOutcome => {
    // No entry ran: a literal member held before the first one. That is a
    // decision by VALUES, worded exactly as `decideLocally` words its winner —
    // "Decided by code-behind" over a chain no code touched was a claim about
    // code that did not run.
    const winner = selected === null ? undefined : plan[selected];
    const reasoning =
      !ranCode && winner && 'literal' in winner
        ? winner.literal.reasoning
        : redactText(codeReasoning(answers));
    logger.debug(
      selected === null
        ? `Condition judge: none held — ${reasoning}`
        : `Condition judge: ${String.fromCharCode(65 + selected)} ("${asked[selected]!.condition}") held — ${reasoning}`,
    );
    return { kind: 'decided', selected, reasoning, ranCode };
  };

  for (let position = 0; position < plan.length; position++) {
    if (executorOptions.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }
    const member = asked[position]!;
    const item = plan[position]!;
    if ('literal' in item) {
      answers.push({ condition: member.condition, holds: item.literal.holds, byValues: true });
      if (item.literal.holds) return decided(position);
      continue;
    }

    if (!ranCode) {
      // The same gate the model gets. A condition is a question about the page
      // once it has finished moving, and code cannot know when that is.
      await settleBeforeConditions(executorOptions);
      if (executorOptions.signal?.aborted) {
        throw new DOMException('Run aborted by client', 'AbortError');
      }
      ranCode = true;
    }

    const { binding } = item;
    // Captured before anything can discard it: the row's code block shows the
    // entry that ran, even when this visit then throws it away.
    const entry = binding.entry!;
    const outcome = await runConditionCode(binding, executorOptions, `condition:${member.index + 1}`);
    (code.ran ??= []).push({ binding, entry, logs: outcome.logs });

    if (outcome.status === 'passed' && outcome.value !== undefined) {
      answers.push({ condition: member.condition, holds: outcome.value, byValues: false });
      if (outcome.value) return decided(position);
      continue;
    }

    // A Stop that lands while the entry runs — it closes the page under the
    // entry, which then throws — is a stop, not broken code and not a failure
    // of the guard. The step path asks the same question after its own entry
    // fails (session-manager.ts, "Post-step abort check"); asked here, it
    // reaches both run loops, and the entry is neither discarded nor flagged.
    if (executorOptions.signal?.aborted) {
      throw new DOMException('Run aborted by client', 'AbortError');
    }

    const error = outcome.error ?? 'unknown error';
    if (!outcome.expectationFailed && !outcome.nonRetryable) {
      return { kind: 'broken', member, binding, error };
    }

    if (outcome.nonRetryable && outcome.nonRetryableKind === 'exit-unclaimed') {
      logger.error(`Condition "${member.condition}" FAILED (code-behind called step.exit())`);
      return {
        kind: 'failed',
        member,
        error: CONDITION_EXIT_REFUSED,
        reasoning:
          'This condition\'s code-behind called `step.exit()`. A condition answers ' +
          'true or false — it cannot end the flow. The entry was kept: the model ' +
          'would not change the rule.',
      };
    }
    if (outcome.nonRetryable) {
      logger.error(`Condition "${member.condition}" FAILED (code-behind): ${error}`);
      return {
        kind: 'failed',
        member,
        error,
        reasoning:
          'The file this condition\'s code-behind names could not be resolved, so the ' +
          'entry could not answer. The code-behind is not at fault and was kept: the ' +
          'model would not make the file appear.',
      };
    }
    // `step.expect` / `step.fail` — a real failure of the guard, never healed.
    // Masked here, as the step path masks it: the message is a string the test
    // wrote, and it interpolates a captured value as readily as not.
    const masked = redactText(error);
    logger.error(`Condition "${member.condition}" FAILED (code-behind assertion): ${masked}`);
    return {
      kind: 'failed',
      member,
      error: masked,
      ...(outcome.deliberate && { deliberate: true }),
      reasoning: outcome.deliberate
        ? 'This condition\'s code-behind called `step.fail(...)`: a deliberate ' +
          'failure, not broken code, so the model was not asked.'
        : 'A `step.expect` in this condition\'s code-behind failed. That is a real ' +
          'failure of the guard, not broken code, so the model was not asked.',
    };
  }
  return decided(null);
}

/** What a condition entry calling `step.exit()` fails its guard with. */
export const CONDITION_EXIT_REFUSED =
  'step.exit() was called in a condition\'s code-behind. A condition answers true or ' +
  'false — it cannot end the flow. Return a boolean instead.';

/**
 * The sentence a code-decided guard carries in place of the model's words:
 * `Decided by code-behind: "the Next button is enabled" → true`.
 *
 * It quotes the AUTHORED condition, never a value — the same rule the
 * `Condition judge:` log line follows — and marks a member answered from its
 * own values, so a mixed chain says which half was which.
 */
function codeReasoning(
  answers: ReadonlyArray<{ condition: string; holds: boolean; byValues: boolean }>,
): string {
  return `Decided by code-behind: ${answers
    .map((a) => `"${a.condition}" → ${a.holds}${a.byValues ? ' (from its values)' : ''}`)
    .join(', ')}`;
}

/**
 * Decision 8's check: code has said "carry on" at a loop's cap, so the model is
 * asked — once — whether the condition really still holds.
 *
 * Returns the note the cap failure carries (when it stands) and the judge's
 * verdict (when one was asked). A disagreement discards the entry and flags it
 * stale with both answers; the caller then plans on the model's verdict. A
 * strict or keyless run cannot ask, and fails at the cap saying why — and so
 * does a run whose judge throws (not an abort): the cap failure stands with the
 * judge's reason in the note, never as a failure of the code.
 */
async function checkCapWithModel(args: {
  condition: string;
  kind: 'while' | 'repeat';
  holds: boolean;
  passes: number;
  binding: CodeBehindBinding | undefined;
  index: number;
  executorOptions: StepExecutorOptions;
  codeBehind: GuardCodeBehind | undefined;
  code: CodeFacts;
}): Promise<{ capNote: string; judged?: ConditionVerdict; disagreed?: boolean }> {
  const { condition, kind, holds, passes, binding, index, executorOptions, codeBehind, code } = args;
  const decidedBy = " Every pass was decided by this line's code-behind";
  if (codeBehind?.strict || codeBehind?.keyless) {
    return {
      capNote:
        `${decidedBy}, and this run has no model to check it with` +
        `${codeBehind.strict ? ' (a strict replay)' : ''}.`,
    };
  }

  let judged: ConditionVerdict;
  try {
    judged = await evaluateConditions([condition], executorOptions);
  } catch (err) {
    // A stop is a stop (issues/020) — rethrown for the caller's abort path.
    if (executorOptions.signal?.aborted || (err as Error | undefined)?.name === 'AbortError') {
      throw err;
    }
    // The model could not be asked. That is not the code's fault, and it must
    // not reach `evaluateGuard`'s catch, which fails the guard with the
    // judge's words beside the code mark — blaming the entry for the model.
    // The cap failure stands exactly as on a run with no model, saying why
    // the check did not happen.
    const why = err instanceof Error ? err.message : String(err);
    logger.warn(`Condition "${condition}": the model could not be asked at the cap: ${why}`);
    return {
      capNote: `${decidedBy}, and the model could not be asked to check it (${why}).`,
    };
  }
  const modelHolds = judged.selected === 0;
  if (modelHolds === holds) {
    return {
      capNote:
        `${decidedBy}; the model was asked at the cap and agrees the condition ` +
        `${kind === 'while' ? 'still holds' : 'still does not hold'}.`,
      judged,
    };
  }

  // The model disagrees: the loop ends where it says, and the entry that kept
  // saying "carry on" is discarded and flagged with both answers.
  const error =
    kind === 'while'
      ? `the code said "${condition}" still held at pass ${passes}; the page says it does not`
      : `the code said "${condition}" still did not hold at pass ${passes}; the page says it does`;
  logger.warn(`Code-behind for condition "${condition}" overruled at the cap: ${error}`);
  if (binding) {
    code.stale = { index, file: binding.file, source: binding.source, error };
    binding.entry = undefined;
  }
  code.fromCodeBehind = false;
  return { capNote: '', judged, disagreed: true };
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
  /**
   * The code-behind half of the evaluation, passed straight through — see the
   * same fields on {@link GuardEvaluation}. A guard row carries them exactly as
   * a step row does, so every surface that already reads a step's code mark,
   * ⚠ and heal-skipped advice reads a guard's too
   * (stories/codebehind-loops-and-conditions.md, decision 15).
   */
  fromCodeBehind?: boolean | undefined;
  codeBehind?: StepResult['codeBehind'] | undefined;
  codeBehindStale?: StepResult['codeBehindStale'] | undefined;
  codeBehindHealSkipped?: StepResult['codeBehindHealSkipped'] | undefined;
  guard?: StepResult['guard'] | undefined;
  /** A condition entry's `step.fail(...)` — see {@link GuardEvaluation.deliberate}. */
  deliberate?: boolean | undefined;
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
    ...(args.fromCodeBehind && { fromCodeBehind: true }),
    ...(args.codeBehind !== undefined && { codeBehind: args.codeBehind }),
    ...(args.codeBehindStale !== undefined && { codeBehindStale: args.codeBehindStale }),
    ...(args.codeBehindHealSkipped !== undefined && {
      codeBehindHealSkipped: args.codeBehindHealSkipped,
    }),
    ...(args.guard !== undefined && { guard: args.guard }),
    ...(args.deliberate && { deliberate: true }),
  };
}

/**
 * The code-behind fields of a {@link GuardEvaluation}, in the shape
 * {@link guardResult} takes — so each run loop passes them with one spread and
 * none of them can forget one.
 */
export function guardCodeBehindFields(
  evaluation: GuardEvaluation,
): Pick<
  Parameters<typeof guardResult>[0],
  'fromCodeBehind' | 'codeBehind' | 'codeBehindStale' | 'codeBehindHealSkipped' | 'guard' | 'deliberate'
> {
  return {
    ...(evaluation.deliberate && { deliberate: true }),
    ...(evaluation.fromCodeBehind && { fromCodeBehind: true }),
    ...(evaluation.codeBehind !== undefined && { codeBehind: evaluation.codeBehind }),
    ...(evaluation.codeBehindStale !== undefined && { codeBehindStale: evaluation.codeBehindStale }),
    ...(evaluation.codeBehindHealSkipped !== undefined && {
      codeBehindHealSkipped: evaluation.codeBehindHealSkipped,
    }),
    ...(evaluation.guard !== undefined && { guard: evaluation.guard }),
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
    // Whose names these are, recorded on the COPY — the registry is by object
    // identity, so a `{ ...bindings }` arrives unmarked and `redactReport`
    // would decide every dotted one by the author rule, masking `AU` because
    // a column is called `keyword` (§7.6, the round-2 defect). Marked
    // directly rather than inherited from the live map, because this map IS
    // the pass's bindings and nothing else is in it: `applyPassBindings` is
    // about to record exactly these names over there, from exactly this
    // object, and it has not run yet on the first pass.
    markLoopBindings(
      marker.values,
      Object.keys(marker.values).filter((key) => key.includes('.')),
    );
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
