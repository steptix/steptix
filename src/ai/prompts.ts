import type { ChatMessage } from './types.js';
import type { PageInfo } from '../browser/manager.js';
import type { PageStateDiagnosis } from '../browser/page-state.js';

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
5. Only include an "assert" action when the step instruction explicitly asks to verify, check, or confirm something. Do NOT add an assert to confirm that a click or other action succeeded — action success is determined by whether it throws an error, not by an assertion
6. If you encounter an unexpected popup/modal/banner, include a "dismiss" action BEFORE your main actions
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
11. For "select" actions, set "selector" to the <select> element itself (NOT an <option>) and "value" to the visible option text (e.g. "Transaction Dispute"). Never click <option> elements directly — always use the "select" action on the parent <select>
12. For "wait" actions, set "condition" to a CSS selector, URL pattern, keyword like "networkidle", or a duration like "30s", "2m", "1m 30s"
13. For "read" actions, set "selector" to the CSS selector of the element to read and "as" to a snake_case variable name. Use "read" when a step asks you to capture, note, remember, store, or take note of a value from the page (e.g. "capture the residential address", "take note of the balance", "note the email"). If the step specifies a variable name via [store as: name], use that name exactly. Otherwise derive a concise snake_case name from what is being captured (e.g. "residential address" → "residential_address", "account balance" → "account_balance"). Captured values become available as {{variable_name}} in later steps
14. For "count" actions, set "selector" to the CSS selector to count and "as" to a snake_case variable name. Use "count" when a step asks how many elements exist (e.g. "how many accounts", "count the rows"). The result is stored as a string (e.g. "3") and available as {{variable_name}} in later steps
15. Set "needs_reeval": true if you have returned all the actions you can plan from the current page state, but more actions are needed to complete the step — e.g. you need to navigate first and then interact with elements on the new page. Omit or set false when the step is complete after the returned actions
16. For elements inside an <iframe>, set "frame" to the CSS selector of the iframe element (shown in the <!-- comment --> after the <iframe> tag). For **nested iframes** (an iframe inside another iframe), chain the selectors with " >> " from outermost to innermost. Example: if the DOM snapshot shows \`<iframe id="outer"> <!-- #outer -->\n  <iframe id="inner"> <!-- #inner -->\n    <button id="btn">\`, then to click #btn set "frame": "#outer >> #inner", "selector": "#btn". Never put an iframe selector inside the "selector" field — iframe traversal belongs entirely in the "frame" field. Omit "frame" for elements in the main page
17. When the application opens a new window or tab (via window.open or target="_blank"), the framework tracks all open pages. An "Open Pages" section will appear in the prompt listing each page with its label, URL, and title. Use a "switchPage" action to switch context before interacting with another page: { "action": "switchPage", "page": "page:2", "description": "Switch to popup window" }. After switching, all actions execute against that page and the DOM snapshot will reflect it on the next turn (set "needs_reeval": true after switchPage). Use "switchPage" with "main" to return to the original page. Do NOT use switchPage if there is only one page open
${apiContext?.hasApiContext ? `
## API Actions (use when the step describes an API call)
When a step describes an HTTP request (not a browser interaction), return an "api_call" action instead of browser actions.

IMPORTANT: The action type MUST be exactly "api_call" — do NOT use "api", "http", "request", or any other value.

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
  "reasoning": "Brief explanation of your approach",
  "needs_reeval": false
}
${apiSection}`;
}

/**
 * Format the open pages section when multiple pages are tracked.
 */
function formatOpenPagesSection(openPages?: PageInfo[]): string {
  if (!openPages || openPages.length <= 1) return '';

  const lines = openPages.map((p) => {
    const marker = p.isActive ? '[active] ' : '';
    const titlePart = p.title ? ` (${p.title})` : '';
    return `- ${marker}${p.label}: ${p.url}${titlePart}`;
  });

  return `## Open Pages
${lines.join('\n')}

To interact with a different page, use a "switchPage" action first:
{ "action": "switchPage", "page": "<label>", "description": "Switch to <target>" }
After switching, set "needs_reeval": true so the framework captures the new page's DOM.

`;
}

/**
 * Build the user message content for a step — text prompt plus screenshot.
 */
export function buildStepMessage(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  conversationHistory: string[],
  openPages?: PageInfo[],
): ChatMessage {
  const historySection =
    conversationHistory.length > 0
      ? `## Prior Steps\n${conversationHistory.join('\n')}\n\n`
      : '';

  const openPagesSection = formatOpenPagesSection(openPages);

  const textContent = `${historySection}${openPagesSection}## Current Step
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
 * Asks the AI to evaluate whether the current page state (and/or prior API responses) satisfies the step assertion.
 */
export function buildAssertionMessage(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  apiResponseHistory?: string,
): ChatMessage {
  const apiSection = apiResponseHistory
    ? `\n\n## Prior API Responses (IMPORTANT — evaluate assertions about "the response" or API data against this section)\n${apiResponseHistory}`
    : '';

  const context = apiResponseHistory
    ? 'the current page state AND the prior API responses below. IMPORTANT: If the assertion refers to "the response", API data, or data not visible on the page, evaluate it against the Prior API Responses section, NOT the page DOM.'
    : 'the current page state';

  const textContent = `Evaluate whether the following test assertion PASSES or FAILS based on ${context}.

## Assertion
${stepInstruction}
${apiSection}

## Current Page DOM
\`\`\`html
${domSnapshot}
\`\`\`

Respond with ONLY this JSON format:
{
  "pass": true or false,
  "actual": "the actual value you found",
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
  /** Actions that succeeded before the failure occurred */
  completedActions?: Array<{ action: string; description: string }>;
  /** URL at the start of the failed attempt */
  startUrl?: string;
  /** URL at the moment of failure */
  failureUrl?: string;
  /** Whether navigation occurred during the failed attempt */
  navigated?: boolean;
}

/** Full diagnostics passed to buildRetryContext on retry attempts */
export interface RetryDiagnostics {
  failures: PriorFailureContext[];
  /** Page state diagnosis captured at the start of the retry attempt */
  pageState?: PageStateDiagnosis;
  /** Which attempt number this is (2 = first retry) */
  attemptNumber: number;
}

/**
 * Build a retry hint block that is appended to the user message on retry.
 * Provides state-aware context so the AI can diagnose the current page state
 * rather than blindly trying different selectors.
 *
 * Accepts either a plain PriorFailureContext[] (backward-compatible) or
 * a full RetryDiagnostics object with page state diagnosis.
 */
export function buildRetryContext(input: PriorFailureContext[] | RetryDiagnostics): string {
  const diagnostics: RetryDiagnostics = Array.isArray(input)
    ? { failures: input, attemptNumber: 2 }
    : input;

  if (diagnostics.failures.length === 0) return '';

  const sections: string[] = [];

  // --- Section 1: What happened in the previous attempt ---
  for (const f of diagnostics.failures) {
    const completedLines: string[] = [];
    if (f.completedActions && f.completedActions.length > 0) {
      completedLines.push('The following actions SUCCEEDED before the failure:');
      for (const a of f.completedActions) {
        completedLines.push(`  - ${a.description}`);
      }
      completedLines.push('');
    }

    let failDetail = `Action "${f.actionType}"`;
    if (f.selector) failDetail += ` with selector \`${f.selector}\``;
    failDetail += ` failed: ${f.error}`;
    if (f.matchCount !== undefined) {
      if (f.matchCount === 0) {
        failDetail += `\n  → No elements matched this selector.`;
      } else if (f.matchCount > 1) {
        failDetail += `\n  → ${f.matchCount} elements matched — use a more specific selector.`;
      }
    }

    sections.push([
      '### What happened in the previous attempt',
      ...completedLines,
      `Then this action FAILED:\n- ${failDetail}`,
    ].join('\n'));
  }

  // --- Section 2: Page state changed (navigation detected) ---
  const navigated = diagnostics.failures.find((f) => f.navigated);
  if (navigated) {
    sections.push([
      '### Page state changed during the previous attempt',
      `- The page navigated from ${navigated.startUrl} to ${navigated.failureUrl}`,
      '- The prior actions may have partially succeeded — do NOT repeat them blindly.',
      '- Check the current DOM and screenshot to see if the step is already complete or partially complete.',
    ].join('\n'));
  }

  // --- Section 3: Current page state assessment ---
  const ps = diagnostics.pageState;
  if (ps) {
    const stateLines: string[] = [];

    if (ps.documentLoading) {
      stateLines.push('- The document is still loading (readyState is not "complete").');
    }

    if (ps.isLoading && ps.loadingIndicators.length > 0) {
      stateLines.push(
        `- Loading indicators are visible: ${ps.loadingIndicators.join(', ')}`,
        '  → Consider using a "wait" action (e.g. wait for networkidle or a specific element) before interacting.',
      );
    }

    if (ps.hasErrorOverlay && ps.errorMessages.length > 0) {
      stateLines.push(
        `- Error overlay detected: ${ps.errorMessages[0]!.slice(0, 300)}`,
        '  → Consider dismissing this or addressing the error before retrying the original action.',
      );
    }

    if (ps.hasModal) {
      stateLines.push(
        '- A modal/dialog is currently visible.',
        '  → You may need to dismiss it or interact with it before proceeding.',
      );
    }

    if (stateLines.length > 0) {
      sections.push(['### Current page state assessment', ...stateLines].join('\n'));
    }
  }

  // --- Section 4: Instructions for this retry ---
  const instructions: string[] = [];
  let step = 1;

  instructions.push(`${step++}. LOOK at the screenshot and DOM snapshot carefully — the page may be in a different state than you expect.`);

  if (ps?.isLoading) {
    instructions.push(`${step++}. Loading indicators are present — use a "wait" action first (e.g. wait for networkidle, or wait for a specific element to appear).`);
  }
  if (ps?.hasModal || ps?.hasErrorOverlay) {
    instructions.push(`${step++}. A modal or error overlay is visible — dismiss it before attempting the original action.`);
  }

  instructions.push(`${step++}. If the page has navigated, check whether the step is already partially or fully complete.`);
  instructions.push(`${step++}. Do NOT blindly repeat the same actions — assess what has already been accomplished.`);

  const failedSelectors = diagnostics.failures
    .map((f) => f.selector)
    .filter(Boolean);
  if (failedSelectors.length > 0) {
    instructions.push(
      `${step++}. Failed selectors from prior attempt: ${failedSelectors.map((s) => `\`${s}\``).join(', ')} — choose a different selector or approach.`,
    );
  }

  sections.push(['### Instructions for this retry', ...instructions].join('\n'));

  return `\n\n## Retry Attempt ${diagnostics.attemptNumber}\n\n${sections.join('\n\n')}`;
}

/**
 * Build the user message for a continuation turn in a multi-turn step.
 * Sent on turns > 1, after the AI has requested re-evaluation via needs_reeval.
 */
export function buildContinuationMessage(
  originalInstruction: string,
  completedActions: Array<{ action: string; description: string; selector?: string }>,
  capturedVariables: Record<string, string>,
  currentUrl: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  turnNumber: number,
  openPages?: PageInfo[],
): ChatMessage {
  const actionLines = completedActions.length > 0
    ? completedActions.map((a) => `  - ${a.description}`).join('\n')
    : '  (none)';

  const variableLines = Object.entries(capturedVariables).length > 0
    ? Object.entries(capturedVariables).map(([k, v]) => `  ${k} = "${v}"`).join('\n')
    : '  (none)';

  const openPagesSection = formatOpenPagesSection(openPages);

  const textContent = `You are continuing the execution of a step.

Original instruction: "${originalInstruction}"

Actions completed so far (turns 1–${turnNumber - 1}):
${actionLines}

Variables captured so far:
${variableLines}

Current URL: ${currentUrl}

${openPagesSection}## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`

[Screenshot is attached as an image — use it to understand the current visual state of the page]

What actions are needed to complete the original instruction?
Set needs_reeval: true again only if you still cannot complete the step from this page state.`;

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
