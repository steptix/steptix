import type { StepResult } from '../report/types.js';
import type { ParsedSetStep } from '../parser/set-step.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { resolveSetTemplate } from './placeholder-substitution.js';
import { clearDottedKeys } from './control-runtime.js';

/**
 * Running one `Set {{name}} to "template"` step
 * (stories/variable-assignment.md).
 *
 * Shared by all four step loops — the CLI runner (main flow and hook scopes),
 * the Sessions API, the errand runner and the Electron runner — because all
 * four shape a `StepResult` and the story's whole claim is that they behave
 * identically. A second copy is how one of them starts disagreeing about what
 * an assignment costs or what it reports.
 *
 * No page, no model, no cache: the only inputs are the template and the scope,
 * and the only effect is one key written into that scope.
 */
export interface SetStepOutcome {
  result: StepResult;
  /** Present only when the assignment happened. The callers that stream
   *  `capture` events need the pair; the CLI only needs the result. */
  assigned?: { name: string; value: string };
}

export function runSetStep(
  step: ParsedSetStep,
  /** The line as the report should show it — the authored text, since a Set
   *  step is never interpolated before it runs. */
  instruction: string,
  index: number,
  scope: Record<string, string>,
  envData?: EnvDataContext | null | undefined,
  definedLater?: ReadonlySet<string> | undefined,
): SetStepOutcome {
  const startedAt = Date.now();
  const outcome = resolveSetTemplate(
    step.name,
    step.template,
    { parameters: scope, ...(envData ? { envData } : {}) },
    definedLater,
  );

  const base: Omit<StepResult, 'status'> = {
    index,
    instruction,
    turns: [],
    durationMs: Date.now() - startedAt,
    retried: false,
  };

  if ('error' in outcome) {
    return {
      result: {
        ...base,
        status: 'failed',
        error: outcome.error,
        aiExplanation: `Set {{${step.name}}} was not assigned`,
      },
    };
  }

  // The write. Everything downstream — a later step's `{{…}}`, the Variables
  // panel, the report's captured box — reads it from here.
  //
  // `defineProperty`, not `scope[name] =`, because of `__proto__`: on a plain
  // object that assignment hits the prototype setter, which ignores a string.
  // The step then reported PASSED with the value in its `outputs` (a computed
  // key does create an own property) while the scope held nothing, so a later
  // `{{__proto__}}` failed as undefined — a green step poisoning a later one,
  // which is the exact failure the "unresolved reference fails the step"
  // decision exists to prevent. This codebase already guards the same hazard
  // in three other maps (`markdown.ts`, `expander.ts`); the omission here was
  // an oversight, not a judgement.
  Object.defineProperty(scope, step.name, {
    value: outcome.value,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  // A rebind of a ROOT erases that root's dotted keys, exactly as a loop pass
  // does (`applyPassBindings`, control-runtime.ts) — same helper, so the two
  // cannot disagree about what a rebind means. A `Set {{order}} to "none"`
  // after a `For each {{order}} …` wrote the flat name only, so `{{order.id}}`
  // went on substituting the last row's id from a variable the author had just
  // overwritten, and §8.3's refusal listed "available properties" of a value
  // nothing binds any more. Guarded on the flat spelling because a `Set`
  // target is flat by construction — a step writes a variable, never one
  // property of one — and a dotted target, if one ever parsed, would be a
  // property write rather than a rebind.
  if (!step.name.includes('.')) clearDottedKeys(scope, new Set([step.name]));

  // A skill-internal name is namespaced by `applySkillScope` and must never
  // be reported: `computeStepCaptures` (CLI) and `autoCapturedNames` (server,
  // errand) both drop `__skill*`, and writing `outputs` / `assigned`
  // directly bypassed both — so a `Set {{scratch}}` inside a skill surfaced
  // `__skill1_scratch` in the report, the HTTP outputs map and the Variables
  // panel. The assignment itself still happens; only its reporting is
  // suppressed, which is exactly what the two existing filters do.
  const reportable = !step.name.startsWith('__skill');

  return {
    result: {
      ...base,
      status: 'passed',
      // `outputs` directly rather than through `computeStepCaptures`, which
      // fills it from `read`/`count` sub-actions and would find none. Same
      // move the tool branch makes with `toolStep.outputs`.
      ...(reportable && { outputs: { [step.name]: outcome.value } }),
      aiExplanation: `Set ${step.name} = "${outcome.value}"`,
    },
    ...(reportable && { assigned: { name: step.name, value: outcome.value } }),
  };
}
