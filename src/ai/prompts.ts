import type { ChatMessage } from './types.js';

/** Viewport dimensions passed to the system prompt */
export interface ViewportInfo {
  width: number;
  height: number;
}

/** Optional API context to augment the system prompt for tests with API steps */
export interface ApiPromptContext {
  /** History of prior API responses, formatted for AI consumption */
  responseHistory: string;
  /** Whether any API context files were loaded (enables API action types) */
  hasApiContext: boolean;
}

/**
 * Classify viewport width into a device mode label.
 */
function classifyDeviceMode(width: number): string {
  if (width >= 1024) return 'desktop';
  if (width >= 768) return 'tablet';
  return 'mobile';
}

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
  viewport?: ViewportInfo,
  apiContext?: ApiPromptContext,
): string {
  const stepInfo =
    currentStep !== undefined && totalSteps !== undefined
      ? `- Current Step: ${currentStep} of ${totalSteps}`
      : '';

  const baseUrlInfo = baseUrl ? `- Base URL: ${baseUrl}` : '';

  let viewportInfo = '';
  if (viewport) {
    const mode = classifyDeviceMode(viewport.width);
    viewportInfo = `- Viewport: ${viewport.width}×${viewport.height}px (${mode} view)`;
  }

  const apiSection = buildApiSection(apiContext);

  return `You are an expert UI test automation agent. You control a web browser and can also execute API calls.

${contextContent ? `## Application Context\n\n${contextContent}\n\n` : ''}## Test Information
- Test: ${testName}
${baseUrlInfo}
${stepInfo}
${viewportInfo}

## Your Task
Execute the following test step by returning a JSON object with an array of actions.

## Rules
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Each action must have: { "action": string, "description": string } plus relevant fields
3. Use CSS selectors. Prefer data-testid > id > aria-label > name > visible text
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. In the DOM snapshot, elements are annotated with their position (e.g. [pos:x,y w×h]) — prefer elements whose position is within the visible viewport and ignore off-screen or zero-size duplicates
5. If the step requires an assertion, include an "assert" action as the last action
6. If you encounter an unexpected popup/modal/banner, include a "dismiss" action BEFORE your main actions
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
11. For "wait" actions, set "condition" to a CSS selector, URL pattern, or keyword like "networkidle"
${apiContext?.hasApiContext ? `
## API Actions (use when the step describes an API call)
When a step describes an HTTP request (not a browser interaction), return an "api_call" action instead of browser actions:

{ "action": "api_call", "method": "GET", "url": "https://...", "apiHeaders": {}, "body": {}, "apiMode": "standalone"|"browser", "description": "..." }

- Set "apiMode" to "browser" for Front Proxy or Experience APIs (they need browser session cookies)
- Set "apiMode" to "standalone" (or omit) for Private, Serverless, or Public APIs
- For Private APIs, include the x-api-key header in "apiHeaders" using the value from the context
- For Front Proxy APIs that need CSRF, first return an "extract_csrf" action to get the token:
  { "action": "extract_csrf", "selector": "input[name='__RequestVerificationToken']", "source": "/delegates", "description": "Extract CSRF token" }
  Then include the token as a header in the following api_call action.
- To extract a value from a prior API response for use in the current step:
  { "action": "extract_value", "from": "step_N", "path": "data.0.id", "as": "delegateId", "description": "..." }` : ''}

## Response Format
{
  "actions": [
    { "action": "click", "selector": "#login-btn", "description": "Click the login button" },
    { "action": "assert", "condition": "dashboard visible", "expected": "balance > 0", "description": "Verify dashboard loaded" }
  ],
  "reasoning": "Brief explanation of your approach"
}
${apiSection}`;
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

/** Context from a prior failed attempt, used to guide the AI on retry */
export interface PriorFailureContext {
  /** The selector that was tried */
  selector: string;
  /** The error message from the failed action */
  error: string;
  /** How many elements matched the selector (0 = not found, >1 = ambiguous) */
  matchCount?: number;
  /** The action type that failed */
  actionType: string;
}

/**
 * Build a retry hint block that is appended to the user message on retry.
 * Tells the AI what was already tried so it picks a different approach.
 */
export function buildRetryContext(failures: PriorFailureContext[]): string {
  if (failures.length === 0) return '';

  const lines = failures.map((f) => {
    let detail = `- Action "${f.actionType}" with selector \`${f.selector}\` failed: ${f.error}`;
    if (f.matchCount !== undefined) {
      if (f.matchCount === 0) {
        detail += `\n  → No elements matched this selector.`;
      } else if (f.matchCount > 1) {
        detail += `\n  → ${f.matchCount} elements matched this selector — the first one was used but it was not the right target. Use a more specific selector (e.g. scope with a parent, use :nth-of-type(), :has-text(), or combine with other attributes) to target the correct element.`;
      }
    }
    return detail;
  });

  return `\n\n## Previous Attempt Failed
The following actions were tried and failed. Choose a DIFFERENT approach — do not reuse the same selectors that failed.

${lines.join('\n')}`;
}

/**
 * Build the optional API response history section for the system prompt.
 */
function buildApiSection(apiContext?: ApiPromptContext): string {
  if (!apiContext?.hasApiContext) return '';
  if (!apiContext.responseHistory) return '';

  return `\n## API Response History\nThe following API calls have been made in prior steps of this test:\n\n${apiContext.responseHistory}`;
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
