/**
 * The condition judge's prompt on the COMPUTER surface
 * (docs/specs/SPEC-use-computer.md §5.6).
 *
 * An `If … then` / `While …` / `Repeat … until` condition judged while the run
 * is on the computer surface used to go out as the PAGE judge's request with
 * the DOM fence swapped for a sentence: the whole browser system prompt —
 * selector strategy, the page action vocabulary, the API rules, table reads —
 * around one screenshot of the screen. None of that applies to a question
 * about a screenshot, and it is most of the request: measured by the test that
 * pins this file, the page-prompt request was several times the size of this
 * one. A condition still `waiting` re-asks every 3 s for up to 30 s, so the
 * difference is paid up to ten times per decision.
 *
 * So this surface gets its own short request, and it keeps exactly what the
 * question needs:
 *
 *  - what the image is (the whole screen, not a page) and its pixel size;
 *  - the conditions, labelled A, B, C… in chain order, as authored;
 *  - the `## Values` block, built by the page judge's own formatter from the
 *    same `StepValues`, so a secret is masked by the same three rules;
 *  - the prior steps and the project context, which both judges and the
 *    computer step's own prompt carry, because a condition is often worded in
 *    the application's vocabulary;
 *  - the page judge's RESPONSE FORMAT, verbatim in its keys and labels, so
 *    `parseBranchedResponse` and the label handling in `evaluateConditions`
 *    read this answer exactly as they read the other one.
 *
 * What it leaves out is everything that describes a page or acting on one: no
 * DOM, no page actions, no API context, no open-tab list, no viewport.
 *
 * A separate module rather than a branch in `src/ai/prompts.ts`, so the page
 * judge's request stays byte-for-byte what it was — a test pins that too.
 */
import type { ChatMessage, MessageContentBlock } from '../ai/types.js';
import { formatParameterBlock, type StepValues } from '../ai/prompts.js';

export interface ComputerJudgeInput {
  /** Authored condition text, in chain order. Labelled A, B, C… here. */
  conditions: string[];
  /** The capture the model judges, as the model sees it (downscaled PNG). */
  screenshotBase64: string;
  /** The capture's size in pixels — the size of the image, not of the screen. */
  imageWidth: number;
  imageHeight: number;
  /** The run's `## Prior Steps` lines, already masked by the runner. */
  conversationHistory: string[];
  /** The project's context files, as every other prompt in the run gets them. */
  contextContent?: string | undefined;
  /** What the conditions' placeholders hold — the page judge's `StepValues`. */
  values?: StepValues | undefined;
}

/** The system prompt's fixed text. Exported so a test can say what it is not. */
export const COMPUTER_JUDGE_SYSTEM_TEXT = `You judge whether a condition holds on a computer's screen, from a screenshot of the WHOLE screen — operating-system windows, dialogs, menus and the taskbar included; a web browser, if there is one, is just one window among them. There is no DOM and no page to inspect: the screenshot is the only evidence.

You are NOT performing a step. You take no actions; you answer a question about what the screenshot shows.

## Rules
1. Return ONLY valid JSON — no markdown, no explanation outside JSON.
2. Judge only what the screenshot shows. A condition is true only when the screenshot shows it is. Do not assume what might be off-screen, behind another window, minimised, or about to appear — if you cannot see it, it is not true, and your reasoning says what you saw instead.`;

/**
 * The `## Values` block, or '' when no condition references anything — the
 * page judge's `formatValuesBlock`, over the same exported formatter and with
 * the same arguments, so the two cannot mask differently.
 */
function valuesText(values: StepValues | undefined): string {
  if (!values) return '';
  const { parameters, envRefs = [] } = values;
  if (parameters.length === 0 && envRefs.length === 0) return '';
  return formatParameterBlock(
    parameters,
    envRefs,
    values.unmask ?? new Set<string>(),
    values.secrets ?? [],
    values.map,
  );
}

/**
 * The judge's messages on the computer surface: a short system prompt and one
 * user message carrying the screenshot. The answer is the page judge's shape —
 * `{ "matched": "<label | none | waiting>", "actions": [], "reasoning" }`.
 */
export function buildComputerConditionJudgeMessages(input: ComputerJudgeInput): ChatMessage[] {
  const system: MessageContentBlock[] = [{ type: 'text', text: COMPUTER_JUDGE_SYSTEM_TEXT, cache: true }];
  if (input.contextContent && input.contextContent.trim() !== '') {
    system.push({ type: 'text', cache: true, text: `## Project context\n${input.contextContent}` });
  }

  const labels = input.conditions.map((_, i) => String.fromCharCode(65 + i));
  const conditionLines = input.conditions.map((condition, i) => `${labels[i]}) ${condition}`).join('\n');

  const sections: string[] = [];
  if (input.conversationHistory.length > 0) {
    sections.push(`## Prior Steps\n${input.conversationHistory.join('\n')}`);
  }
  sections.push(
    `## Decision — Which Condition Holds On The Screen?

Read the conditions in order and answer with the label of the FIRST one the screenshot shows to be true right now. Do not pick the one that seems most likely or most likely to be intended — pick the first one the screenshot actually shows.

${conditionLines}

**Instructions:**
- Answer with a single label (${labels.join(', ')}) when the screenshot shows that condition is true now.
- Answer "none" when it shows none of them. A condition the screenshot does not show — not on screen, hidden, too unclear to read, or simply false — counts as not true: that is "none", with the reason in \`reasoning\`. Do not guess.
- Answer "waiting" ONLY when the screen is visibly mid-transition (a window opening or closing, a progress bar, a spinner) so that you cannot yet tell. Never use "waiting" for a condition you can see is false.`,
  );
  const values = valuesText(input.values);
  if (values) sections.push(`## Values\n${values}`);
  sections.push(
    `## Screen\nThe attached image is the current screen, ${input.imageWidth}×${input.imageHeight} pixels.`,
  );
  sections.push(`## Response Format
{
  "matched": "<label, 'none' or 'waiting'>",
  "actions": [],
  "reasoning": "Brief explanation of what the screenshot shows, and which condition that makes true"
}

\`actions\` is always empty here, whatever you answer — this decision performs nothing.`);

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: sections.join('\n\n') },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${input.screenshotBase64}` } },
      ],
    },
  ];
}
