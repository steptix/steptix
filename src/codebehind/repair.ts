import { formatCaptureLines, formatLoopBlock, formatParameterBlock, type LoopContext } from '../ai/prompts.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import type { ChatMessage, MessageContentBlock } from '../ai/types.js';
import { redact } from '../utils/secrets.js';
import type { RecordedAction } from './recording.js';

/**
 * The compiler's repair prompt (stories/codebehind-compile.md, "Replay").
 *
 * A replay failure is the most informative moment in the whole pipeline: the
 * code is in hand, the error is in hand, and the page is in exactly the state
 * that broke it. This prompt hands the model all three plus the screenshot,
 * and asks for one replacement entry.
 */

export interface RepairPromptInput {
  /** The step's authored text — the entry's `source`, unchanged in the reply. */
  rawStepText: string;
  /** 1-based index of the failing step, for orientation. */
  stepIndex: number;
  /** The entry that failed, as written into the candidate. */
  entryCode: string;
  /** What the step reported when it failed. */
  error: string;
  /** Page state at the failure. */
  dom?: string | undefined;
  url?: string | undefined;
  screenshotBase64?: string | undefined;
  /** Parameter names and their resolved values, as for generation. */
  parameters: Array<{ name: string; value: string }>;
  /** The LIVE variable map they were read out of, as for generation — only so
   *  a dotted name is decided by whose it is (§7.6). Without it a data file's
   *  `user.apikey` heading rendered its credential into this prompt in clear.
   *  The live object or nothing; a copy carries none of the loop marks. */
  parameterMap?: Record<string, string> | undefined;
  /** The run's free-text mask set, as for generation: a secret inside a value
   *  no key names as secret is masked too. */
  secrets?: string[] | undefined;
  /** The step's environment references with their values, as for generation. */
  envRefs?: Array<{ ref: string; value: string }> | undefined;
  /** Which round this is, and how many there are. */
  round?: { number: number; max: number } | undefined;
  /**
   * The runtime loop the step sits in the body of, as generation is told it
   * (stories/codebehind-loops-and-conditions.md, decision 2): the ONE entry
   * replays on every pass, and what changes per pass is read with
   * `step.getVar`. Absent outside every loop, which leaves the prompt as it was.
   */
  loop?: LoopContext | undefined;
  /**
   * What each capture the step makes held on the RECORDING, by the authored
   * capture name — RAW, masked here as the parameter block masks a value
   * (`formatCaptureLines`, the step prompt's own formatter). The result the
   * repaired entry must reproduce.
   */
  recordedCaptures?: Record<string, string> | undefined;
  /**
   * The recorded actions of the pass the entry is repaired from — the AI pass
   * that healed it, or the recording's evidence pass
   * (docs/specs/SPEC-codebehind-robustness.md §6.2). The repair answer is
   * checked against them as a generated one is, and the prompt lists the
   * selectors their reads and counts used, which the answer must keep.
   */
  actions?: RecordedAction[] | undefined;
  /**
   * The one re-ask a refused answer buys: the answer that wrote a recorded
   * value into the code (`askWithCaptureRetry`), or one a static check refused
   * (`askCheckedRepair`), and why. Present only on that second call.
   */
  retry?: { previousEntry: string; complaint: string } | undefined;
}

/**
 * The selectors the pass's reads and counts used, as the repair must keep
 * them — or '' when it made none, which leaves the prompt as it was.
 */
function recordedReadsBlock(actions: readonly RecordedAction[] | undefined, secrets: readonly string[]): string {
  const reads = (actions ?? []).filter(
    (a) => (a.action === 'read' || a.action === 'count') && typeof a.selector === 'string' && a.selector.trim() !== '',
  );
  if (reads.length === 0) return '';
  const lines = reads.map((a) => {
    const kind = a.action === 'count' ? 'count' : a.multiple ? 'read (every match)' : 'read';
    const into = typeof a.as === 'string' ? ` → ${a.as}` : '';
    return `- ${kind} \`${redact(a.selector!, [...secrets])}\`${into}`;
  });
  return (
    `\n\n## What the run read with\nThe run this entry is repaired from read the page with these ` +
    `selectors. A read with any other selector does not throw — it returns different data — so the ` +
    `entry must read with them as written, \`:first-child\` and all:\n${lines.join('\n')}`
  );
}

export function buildRepairPrompt(input: RepairPromptInput): ChatMessage {
  const paramBlock = formatParameterBlock(
    input.parameters,
    input.envRefs ?? [],
    new Set<string>(),
    input.secrets ?? [],
    input.parameterMap,
  );

  // A repair must not "fix" a flow-control entry by giving it the
  // post-condition rule 5 asks for (stories/step-flow-control.md, decision 11).
  // Gated on the claim, so an ordinary step's repair prompt is unchanged.
  //
  // The `fail` verb takes the same carve-out (stories/step-failure-outcomes.md,
  // decision 10): `step.fail` throws exactly as `step.exit` does, so a
  // post-condition bolted on would assert over a line that never runs.
  const flowControl = parseFlowControlStep(input.rawStepText);
  const call = flowControl?.verb === 'fail' ? 'step.fail(<the authored message>)' : 'step.exit()';
  const postConditionRule = flowControl
    ? `5. This step is a flow-control step: it evaluates its condition and calls \`${call}\` when ` +
      'it holds, and does nothing when it does not. It needs NO post-condition — that call throws, ' +
      'so there is nothing after it to assert on. Do not add one; fix the condition or the read it is ' +
      'built from.'
    : '5. End with a post-condition — a `locator.waitFor()` on what the step produced, or a `step.expect(...)` over a value read back from the page. After an action that changes the page, `await step.settle()` before reading or asserting: it waits for the requests the action started and for the page to stop moving.';

  const roundLine = input.round
    ? `\nThis is repair round ${input.round.number} of ${input.round.max}. If you cannot make this step work as code, say so with {"entry": null, "reason": "..."} rather than guessing again.\n`
    : '';

  // What the recording captured, beside the name the entry writes it under —
  // the step prompt's own lines and rule. Absent (the prompt unchanged) when
  // nothing was recorded.
  const recorded = Object.entries(input.recordedCaptures ?? {});
  const captureBlock =
    recorded.length === 0
      ? ''
      : `\n\n## Values this step must capture\n${formatCaptureLines(
          recorded.map(([name]) => name),
          Object.fromEntries(recorded),
          input.secrets ?? [],
          input.parameterMap,
        )}`;

  const retryBlock = input.retry
    ? `\n## Your previous answer was refused\n${input.retry.complaint}\n\nThat answer was:\n\n\`\`\`ts\n${input.retry.previousEntry}\n\`\`\`\n\nFix exactly that, keep the rest of the entry, and return it in the same envelope.\n`
    : '';

  const text = `A generated code-behind entry was replayed and it failed. Rewrite it so it passes.

## The step, exactly as authored
${input.rawStepText}

## Parameters in scope
${paramBlock}${formatLoopBlock(input.loop, 'step')}${captureBlock}${recordedReadsBlock(input.actions, input.secrets ?? [])}

## The entry that failed (step ${input.stepIndex})
\`\`\`ts
${input.entryCode}
\`\`\`

## What went wrong
${input.error}
${retryBlock}${roundLine}
## The page when it failed${input.url ? `\nURL: ${input.url}` : ''}${
    input.dom ? `\n\n\`\`\`html\n${input.dom}\n\`\`\`` : ''
  }${input.screenshotBase64 ? '\n\n[A screenshot of the page at the failure is attached.]' : ''}

## What to return

The replacement entry, as one JSON string field (standard JSON string encoding):

{
  "entry": "{ source: ${JSON.stringify(input.rawStepText).replace(/"/g, '\\"')}, async run({ page, step, log }) { ... } }"
}

Rules:

1. Keep \`source\` **byte-identical** to the authored text above — it is how the entry binds to the step.
2. Fix the cause the error and the DOM actually show. A locator that timed out usually means the selector is wrong or the code raced the page, not that it needs a longer timeout.
3. Read parameters via \`step.getVar\`, never inline their values — and an environment placeholder by the name inside its braces: \`\${data.url}\` is \`step.getVar('data.url')\`. Its value is this environment's; the file must run against the others.
4. Compute dynamic values (dates, derived codes) at runtime.
${postConditionRule}
6. No imports; everything arrives via the context object.

If this step genuinely cannot be expressed as code, decline instead:

{
  "entry": null,
  "reason": "one sentence"
}

Respond with ONLY the JSON object — no prose around it.`;

  if (!input.screenshotBase64) return { role: 'user', content: text };

  const blocks: MessageContentBlock[] = [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshotBase64}` } },
  ];
  return { role: 'user', content: blocks };
}
