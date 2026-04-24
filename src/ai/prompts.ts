import type { ChatMessage, MessageContentBlock } from './types.js';
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

function textBlock(text: string, cache = false): MessageContentBlock {
  return { type: 'text', text, ...(cache && { cache: true }) };
}

export function contentBlocksToText(content: string | MessageContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => block.type === 'text' ? block.text : '[image]')
    .join('\n');
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
 * Format the volatile per-step "Test Information" section that lives in the user
 * message (not the system prompt) so it doesn't break the cacheable system prefix.
 */
export function formatTestInfo(
  testName: string,
  baseUrl?: string,
  currentStep?: number,
  totalSteps?: number,
  viewport?: ViewportInfo,
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
  return [`## Test Information`, `- Test: ${testName}`, baseUrlInfo, stepInfo, viewportInfo]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Options that influence which optional rules are injected into the system prompt.
 */
export interface SystemPromptOptions {
  /** When true, include guidance for handling unexpected popups/modals/banners.
   *  Only enabled when the test has hooks configured — without hooks, the
   *  author has signalled no intent to dismiss UI, so we don't nudge the AI. */
  dismissalGuidance?: boolean;
}

/**
 * Build the system prompt for step execution.
 * Stable instructional blocks are marked cacheable so aiapi v2 can map them per provider.
 * Volatile per-step state (test name, step counter, viewport) lives in the user message
 * via formatTestInfo() so it doesn't invalidate the cacheable system prefix.
 */
export function buildSystemPrompt(
  contextContent: string,
  apiContext?: ApiPromptContext,
  options: SystemPromptOptions = {},
): MessageContentBlock[] {
  const dismissalRule = options.dismissalGuidance
    ? '\n6. If you encounter an unexpected popup/modal/banner, return a "dismiss" action first — you can continue with your main action on the next turn'
    : '';

  const blocks: MessageContentBlock[] = [
    textBlock(`You are an expert UI test automation agent. You control a web browser and can also execute API calls.

## Your Task
Execute the following test step by returning a JSON object with ONE action at a time.
After each action, you will receive an updated screenshot and DOM snapshot showing the result.
Plan your next action based on the observed result — do not batch multiple actions.

## Rules
1. Return ONLY valid JSON — no markdown, no explanation outside JSON
2. Return exactly ONE action per response: { "action": string, "description": string } plus relevant fields. After this action executes, you will see the result and can plan the next action
3. Use CSS selectors. When the step names an element by its visible label/text (e.g. "Click the Verify Code button"), FIRST locate the element in the DOM by matching that exact visible text, then build a selector targeting that specific element. Do NOT pick a different element just because its data-testid, id, or class contains a similar-looking substring — testids are often mislabeled or refer to a nearby element (e.g. data-testid="button-verifyOtp" on a "Didn't get a code?" link, not on the "Verify code" button). Once you have identified the correct element by its text, prefer stable attributes on that element: data-testid > id > aria-label > name > text-based selector (e.g. button:has-text("Verify code")). NEVER use Tailwind utility classes (e.g. .!fixed, .z-[999], .bg-black) in selectors — they contain characters that break CSS parsing. Use semantic selectors instead (role, aria-label, tag, id, data-testid)
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. In the DOM snapshot, elements are annotated with their position (e.g. [pos:x,y w×h]) — prefer elements whose position is within the visible viewport and ignore off-screen or zero-size duplicates
5. Only include an "assert" action when the step instruction explicitly asks to verify, check, or confirm something. Do NOT add an assert to confirm that a click or other action succeeded — you will see the result in the next screenshot${dismissalRule}
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
11. For "select" actions, set "selector" to the <select> element itself (NOT an <option>) and "value" to the visible option text (e.g. "Transaction Dispute"). Never click <option> elements directly — always use the "select" action on the parent <select>
12. For "wait" actions, set "waitType" and "condition":
   - waitType "load": set condition to "networkidle" (preferred for "wait until page loads" type steps), "load", or "domcontentloaded"
   - waitType "duration": set condition to a time like "30s", "2m", "1m 30s"
   - waitType "selector": set condition to a CSS selector to wait for an element to become visible
   - waitType "hidden": set condition to a CSS selector to wait for an element to disappear (e.g. a spinner, loading overlay, or progress bar)
   - waitType "text": set condition to text content to wait for on the page (e.g. "Welcome to Dashboard")
   - waitType "url": set condition to a URL or glob pattern (e.g. "**/dashboard") — only use when the step provides an explicit URL, never guess URLs
   - waitType "count": set condition to a CSS selector and "expected" to the minimum number of matches (e.g. wait for at least 5 table rows)
   - waitType "attribute": set "selector" to the target element, "expected" to "attribute=value" (e.g. "aria-disabled=false") or "!attribute" to wait for removal (e.g. "!disabled")
   - waitType "navigation": wait for the page to navigate away from the current URL — no condition needed
   - waitType "stable": wait for the page to fully stabilise (network idle and no DOM changes) — no condition needed
   If the screenshot shows the page is loading or transitioning (visible spinner, blank content, partially loaded), return a "wait" action to let it settle before proceeding
13. For "read" actions, set "selector" to the CSS selector of the element to read and "as" to a snake_case variable name. Use "read" when a step asks you to capture, note, remember, store, or take note of a value from the page (e.g. "capture the residential address", "take note of the balance", "note the email"). If the step specifies a variable name via [store as: name], use that name exactly. Otherwise derive a concise snake_case name from what is being captured (e.g. "residential address" → "residential_address", "account balance" → "account_balance"). Captured values become available as {{variable_name}} in later steps. By default "read" returns the element's value (for inputs) or its textContent. If the step asks for an attribute — most commonly an href, src, or a URL — set "attribute" to the attribute name (e.g. "href"). The displayed text on a link or breadcrumb often differs from the underlying URL, so always use "attribute": "href" when capturing a link URL rather than reading the visible text
14. For "count" actions, set "selector" to the CSS selector to count and "as" to a snake_case variable name. Use "count" when a step asks how many elements exist (e.g. "how many accounts", "count the rows"). The result is stored as a string (e.g. "3") and available as {{variable_name}} in later steps
15. Set "needs_reeval": true if the current step instruction is NOT yet fully satisfied after this action. Set false (or omit) when the step instruction IS satisfied. IMPORTANT: only consider the current step instruction — do NOT continue into actions that belong to subsequent steps. For example, if the step says "Enter username and password", set needs_reeval: true after entering the username (you still need to enter the password), but set needs_reeval: false after entering the password — do NOT proceed to click Login unless the step says to
16. For elements inside an <iframe>, set "frame" to the CSS selector of the iframe element (shown in the <!-- comment --> after the <iframe> tag). For **nested iframes** (an iframe inside another iframe), chain the selectors with " >> " from outermost to innermost. Example: if the DOM snapshot shows \`<iframe id="outer"> <!-- #outer -->\n  <iframe id="inner"> <!-- #inner -->\n    <button id="btn">\`, then to click #btn set "frame": "#outer >> #inner", "selector": "#btn". Never put an iframe selector inside the "selector" field — iframe traversal belongs entirely in the "frame" field. Omit "frame" for elements in the main page
17. When the application opens a new window or tab (via window.open or target="_blank"), the framework tracks all open pages. An "Open Pages" section will appear in the prompt listing each page with its label, URL, and title. Use a "switchPage" action to switch context before interacting with another page: { "action": "switchPage", "page": "page:2", "description": "Switch to popup window" }. After switching, all actions execute against that page and the DOM snapshot will reflect it on the next turn (set "needs_reeval": true after switchPage). Use "switchPage" with "main" to return to the original page. Do NOT use switchPage if there is only one page open
18. To close a browser tab or popup window, use a "closePage" action: { "action": "closePage", "page": "page:2", "description": "Close the popup window" }. The "page" field accepts the same identifiers as switchPage (label, URL substring, or title substring). You cannot close the main page. After closing, the framework automatically switches back to the main page — set "needs_reeval": true to get the updated DOM snapshot. Use this when a step asks to close a tab, window, or popup
19. For "find" actions, set "value" to the text to search for in the full DOM. The framework will search the entire page and return matching elements with their selectors. Use this when you need to locate a specific item in a collapsed/summarised list (e.g. finding a specific order in a table). Always set "needs_reeval": true
20. For "expand" actions, set "selector" to the CSS selector of the element to expand. The framework will return the full DOM subtree for that element. Use this when the compact DOM shows a collapsed summary and you need to see all children (e.g. expanding a table to see all rows). Always set "needs_reeval": true
21. CRITICAL: Complete ONLY what the current step instruction literally asks for. Do NOT perform follow-up actions that belong to subsequent steps, even if they seem like the obvious next thing to do. Each step is deliberately scoped — the test author has split the workflow into separate steps for a reason. Once the instruction is fulfilled, stop`, true),
  ];

  if (contextContent) {
    blocks.push(textBlock(`## Application Context

${contextContent}`, true));
  }

  if (apiContext?.hasApiContext) {
    blocks.push(textBlock(`## API Actions (use when the step describes an API call)
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
  { "action": "extract_value", "from": "step_N", "path": "data.0.id", "as": "delegateId", "description": "..." }`, true));
  }

  blocks.push(textBlock(`## Response Format
{
  "actions": [
    { "action": "click", "selector": "#login-btn", "description": "Click the login button" }
  ],
  "reasoning": "Brief explanation of your approach",
  "needs_reeval": true
}` , true));

  const apiSection = buildApiSection(apiContext);
  if (apiSection) {
    blocks.push(textBlock(apiSection));
  }

  return blocks;
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
  testInfoSection?: string,
): ChatMessage {
  const historySection =
    conversationHistory.length > 0
      ? `## Prior Steps\n${conversationHistory.join('\n')}\n\n`
      : '';

  const openPagesSection = formatOpenPagesSection(openPages);

  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  const screenshotNote = screenshotBase64
    ? '\n\n[Screenshot is attached as an image — use it to understand the current visual state of the page]'
    : '';

  const textContent = `${testInfoBlock}${historySection}${openPagesSection}## Current Step
${stepInstruction}

## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`${screenshotNote}`;

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
  testInfoSection?: string,
): ChatMessage {
  const apiSection = apiResponseHistory
    ? `\n\n## Prior API Responses (IMPORTANT — evaluate assertions about "the response" or API data against this section)\n${apiResponseHistory}`
    : '';

  const context = apiResponseHistory
    ? 'the current page state AND the prior API responses below. IMPORTANT: If the assertion refers to "the response", API data, or data not visible on the page, evaluate it against the Prior API Responses section, NOT the page DOM.'
    : 'the current page state';

  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  const textContent = `${testInfoBlock}Evaluate whether the following test assertion PASSES or FAILS based on ${context}.

## Assertion
${stepInstruction}
${apiSection}

## Current Page DOM (readable mode — includes visible text content)
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
  /** When true, include hints that push the AI toward dismissing modals/overlays.
   *  Only enabled when the test has hooks configured — without hooks, we assume
   *  dialogs the AI sees are intentional UI, not obstacles. */
  dismissalGuidance?: boolean;
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
      const hint = diagnostics.dismissalGuidance
        ? '  → Consider dismissing this or addressing the error before retrying the original action.'
        : '  → Address the error before retrying the original action.';
      stateLines.push(
        `- Error overlay detected: ${ps.errorMessages[0]!.slice(0, 300)}`,
        hint,
      );
    }

    if (ps.hasModal && diagnostics.dismissalGuidance) {
      stateLines.push(
        '- A modal/dialog is currently visible.',
        '  → If it is unrelated to the current step, dismiss it; otherwise interact with it.',
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
  if ((ps?.hasModal || ps?.hasErrorOverlay) && diagnostics.dismissalGuidance) {
    instructions.push(
      `${step++}. A modal or overlay is visible — if it's unrelated to the current step, dismiss it; otherwise interact with it.`,
    );
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
  explorationResults?: string[],
  testInfoSection?: string,
): ChatMessage {
  const actionLines = completedActions.length > 0
    ? completedActions.map((a) => `  - ${a.description}`).join('\n')
    : '  (none)';

  const variableLines = Object.entries(capturedVariables).length > 0
    ? Object.entries(capturedVariables).map(([k, v]) => `  ${k} = "${v}"`).join('\n')
    : '  (none)';

  const openPagesSection = formatOpenPagesSection(openPages);

  const explorationSection = explorationResults && explorationResults.length > 0
    ? `## Exploration Results\n${explorationResults.join('\n\n')}\n\n`
    : '';

  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  const textContent = `${testInfoBlock}You are continuing the execution of a step.

Original instruction: "${originalInstruction}"

Actions completed so far (turns 1–${turnNumber - 1}):
${actionLines}

Variables captured so far:
${variableLines}

Current URL: ${currentUrl}

${openPagesSection}${explorationSection}## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`${screenshotBase64 ? '\n\n[Screenshot is attached as an image — use it to understand the current visual state of the page]' : ''}

What is the next action needed to complete the original instruction: "${originalInstruction}"?
Return ONE action. Set needs_reeval: false if this instruction is now fully satisfied — do NOT continue into actions that belong to subsequent steps. If the instruction is already satisfied and no further action is required, return { "action": "noop", "description": "<why nothing is needed>", "needs_reeval": false }.`;

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

/** A single outcome in a branched (conditional) step prompt */
export interface BranchOutcome {
  /** Label for this outcome, e.g. "A", "B", "C" */
  label: string;
  /** The original step instruction */
  instruction: string;
  /** Whether this is a conditional step (true) or the continuation/default (false) */
  isConditional: boolean;
}

/**
 * Build the user message for a branched (conditional) step evaluation.
 *
 * Instead of asking the AI about one step at a time, this presents all possible
 * outcomes simultaneously and asks which one matches the current page state.
 * The AI can also respond with "waiting" if the page hasn't settled yet.
 */
export function buildBranchedStepMessage(
  outcomes: BranchOutcome[],
  domSnapshot: string,
  screenshotBase64: string | null,
  conversationHistory: string[],
  openPages?: PageInfo[],
  testInfoSection?: string,
): ChatMessage {
  const historySection =
    conversationHistory.length > 0
      ? `## Prior Steps\n${conversationHistory.join('\n')}\n\n`
      : '';

  const openPagesSection = formatOpenPagesSection(openPages);

  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  const outcomeLines = outcomes
    .map((o) => {
      const tag = o.isConditional ? '(conditional)' : '(default / continuation)';
      return `${o.label}) ${o.instruction} ${tag}`;
    })
    .join('\n');

  const textContent = `${testInfoBlock}${historySection}${openPagesSection}## Branched Step — Determine Which Outcome Applies

The following outcomes are possible after the previous action. Examine the current page state (DOM and screenshot) and determine which outcome has occurred:

${outcomeLines}

**Instructions:**
- If one of the conditional outcomes (${outcomes.filter((o) => o.isConditional).map((o) => o.label).join(', ')}) clearly matches the current page state, respond with that outcome's label and the actions needed to complete it.
- If none of the conditional outcomes match and the page shows the default/continuation state, respond with the continuation label (${outcomes.filter((o) => !o.isConditional).map((o) => o.label).join(', ')}) and any actions needed.
- If the page is still loading/transitioning and none of these outcomes are clearly visible yet, respond with "waiting".

## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`${screenshotBase64 ? '\n\n[Screenshot is attached as an image — use it to understand the current visual state of the page]' : ''}

## Response Format
{
  "matched": "<label or 'waiting'>",
  "actions": [...],
  "reasoning": "Brief explanation of which outcome you see and why"
}

If matched is "waiting", return an empty actions array. Do NOT guess — if the page hasn't settled, say "waiting".`;

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
