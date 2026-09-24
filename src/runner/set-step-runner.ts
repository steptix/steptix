import type { StepResult } from '../report/types.js';
import type { ParsedSetStep } from '../parser/set-step.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { resolveSetTemplate } from './placeholder-substitution.js';
// From the PARSER's light module, not from `control-runtime.ts`: that import
// dragged the step executor — and with it Playwright and the AI client — into
// a "no page, no model" module's graph.
import { bindVariable } from '../parser/parameters.js';

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
 * No page, no model: the only inputs are the template and the scope,
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
  // Both of `bindVariable`'s rules matter to a `Set`. The own-property write
  // is why a `Set {{__proto__}} to "x"` does not report PASSED over a scope
  // that held nothing; the dotted clear is why a `Set {{order}} to "none"`
  // after a `For each {{order}} …` does not leave `{{order.id}}` substituting
  // the last row's id. Same helper as every other writer, so none of them can
  // disagree about what a rebind means.
  bindVariable(scope, step.name, outcome.value);

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
