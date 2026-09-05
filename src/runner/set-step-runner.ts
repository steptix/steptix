import type { StepResult } from '../report/types.js';
import type { ParsedSetStep } from '../parser/set-step.js';
import type { EnvDataContext } from '../parser/interpolate-env-data.js';
import { resolveSetTemplate } from './placeholder-substitution.js';

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
  scope[step.name] = outcome.value;

  return {
    result: {
      ...base,
      status: 'passed',
      // `outputs` directly rather than through `computeStepCaptures`, which
      // fills it from `read`/`count` sub-actions and would find none. Same
      // move the tool branch makes with `toolStep.outputs`.
      outputs: { [step.name]: outcome.value },
      aiExplanation: `Set ${step.name} = "${outcome.value}"`,
    },
    assigned: { name: step.name, value: outcome.value },
  };
}
