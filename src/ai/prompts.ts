import type { ChatMessage } from './types.js';

/**
 * Build the system prompt for step execution.
 * Includes application context and AI behaviour rules.
 */
export function buildSystemPrompt(
  contextContent: string,
  testName: string,
  baseUrl?: string,
  currentStep?: number,
  totalSteps?: number,
): string {
  const stepInfo =
    currentStep !== undefined && totalSteps !== undefined
      ? `- Current Step: ${currentStep} of ${totalSteps}`
      : '';

  const baseUrlInfo = baseUrl ? `- Base URL: ${baseUrl}` : '';

  return `You are an expert UI test automation agent. You control a web browser to execute test steps described in natural language.

${contextContent ? `## Application Context\n\n${contextContent}\n\n` : ''}## Test Information
- Test: ${testName}
${baseUrlInfo}
${stepInfo}

## Your Task
Execute the following test step by returning a JSON object with an array of actions.

## Rules
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Each action must have: { "action": string, "description": string } plus relevant fields
3. Use CSS selectors. Prefer data-testid > id > aria-label > name > visible text
4. If the step requires an assertion, include an "assert" action as the last action
5. If you encounter an unexpected popup/modal/banner, include a "dismiss" action BEFORE your main actions
6. If you cannot determine what to do, return a single "prompt" action with a "question" field
7. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
8. For "navigate" actions, set "url" to the full or relative URL
9. For "type" actions, set "value" to the text to type
10. For "wait" actions, set "condition" to a CSS selector, URL pattern, or keyword like "networkidle"

## Response Format
{
  "actions": [
    { "action": "click", "selector": "#login-btn", "description": "Click the login button" },
    { "action": "assert", "condition": "dashboard visible", "expected": "balance > 0", "description": "Verify dashboard loaded" }
  ],
  "reasoning": "Brief explanation of your approach"
}`;
}

/**
 * Build the user message content for a step — text prompt plus screenshot.
 */
export function buildStepMessage(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  conversationHistory: string[],
): ChatMessage {
  const historySection =
    conversationHistory.length > 0
      ? `## Prior Steps\n${conversationHistory.join('\n')}\n\n`
      : '';

  const textContent = `${historySection}## Current Step
${stepInstruction}

## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`

[Screenshot is attached as an image — use it to understand the current visual state of the page]`;

  if (screenshotBase64) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: textContent },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${screenshotBase64}` },
        },
      ],
    };
  }

  return {
    role: 'user',
    content: textContent,
  };
}

/**
 * Build a follow-up message after a user provides clarification.
 */
export function buildClarificationMessage(
  question: string,
  answer: string,
): ChatMessage {
  return {
    role: 'user',
    content: `The user answered your question.\n\nQuestion: ${question}\nAnswer: ${answer}\n\nPlease continue with the original step using this information.`,
  };
}

/**
 * Build the assertion evaluation prompt.
 * Asks the AI to evaluate whether the current page state satisfies the step assertion.
 */
export function buildAssertionMessage(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
): ChatMessage {
  const textContent = `Evaluate whether the following test assertion PASSES or FAILS based on the current page state.

## Assertion
${stepInstruction}

## Current Page DOM
\`\`\`html
${domSnapshot}
\`\`\`

Respond with ONLY this JSON format:
{
  "pass": true or false,
  "actual": "the actual value you found on the page",
  "explanation": "brief explanation of why it passes or fails"
}`;

  if (screenshotBase64) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: textContent },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${screenshotBase64}` },
        },
      ],
    };
  }

  return {
    role: 'user',
    content: textContent,
  };
}

/**
 * Format a completed step as a conversation history entry.
 */
export function formatStepHistoryEntry(
  index: number,
  instruction: string,
  passed: boolean,
  pageUrl?: string,
): string {
  const status = passed ? '✓ PASSED' : '✗ FAILED';
  const urlInfo = pageUrl ? ` (now at: ${pageUrl})` : '';
  return `Step ${index}: [${status}] ${instruction}${urlInfo}`;
}
