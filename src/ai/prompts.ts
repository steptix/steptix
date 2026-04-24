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
2. Return exactly ONE action per response: { "action": string, "description": string } plus relevant fields. After this action executes, you will see the result and can plan the next action. EXCEPTION: you MAY chain a single "wait" action immediately after a triggering action (click/type/select/navigate/keypress) in the same response when the step instruction names a specific completion condition (a destination URL, a visible element, a count, a text label). Chaining lets Playwright block server-side through redirect chains and async renders with zero polling overhead. Do NOT chain speculative waits — only chain when the completion condition is stated in the instruction
3. SELECTOR STRATEGY. Write selectors that stay correct when the UI changes cosmetically. Follow this process:

   Step A — identify the element by its visible label first. When the step names an element ("Click the Verify code button"), locate it in the DOM snapshot by matching that visible text. Do NOT pick a different element just because its data-testid, id, or class contains a similar-looking substring — testids are often mislabeled or attached to a neighbouring element (e.g. data-testid="button-verifyOtp" on a "Didn't get a code?" link, not on the "Verify code" button). Verify you have found the right element before picking a selector for it.

   Step B — pick the highest-ranked stable handle available ON that element, in this order:
     1. [data-testid="..."] — author-intended test handle (also accept data-test, data-qa, data-cy if the app uses them)
     2. #id — only if the id looks stable. Skip ids that look auto-generated (:r1a:, radix-:r3:, react-aria-:rb4:, long random strings). Those change on every render
     3. [role="button"][name="..."] or [role="link"][name="..."] — accessible role + name; very stable across framework changes
     4. [aria-label="..."] — accessible name (especially for icon-only buttons)
     5. [name="..."] — form-field name attribute
     6. a[href="/route"] — anchor to a known route path. Only when the href is a meaningful path (/logout, /dashboard, /settings), NOT a tracking URL or absolute URL with query parameters
     7. tag:text-is("exact label") — visible text, EXACT match. Preferred for short labels like "New", "OK", "Save", "Login" where substring match would overreach (e.g. "New" matching "News", "Renewal", "Newer")
     8. tag:has-text("substring") — visible text, substring match. Use only when the exact label is long enough that substring is unambiguous, or when :text-is is not practical
     9. Parent-scoped combinations — #site-nav a:text-is("Login"), [data-testid="toolbar"] button:has-text("Save"). Use when the element itself has no stable handle but a nearby ancestor does
     10. nth=N or :nth-child(N) — LAST RESORT. Use only when the page genuinely has multiple interchangeable elements and you need the Nth. Do NOT use nth= to disambiguate between elements that have distinguishing attributes or text — scope to a parent instead

   Pick ONE handle from this ladder. Do NOT glue a class selector onto an attribute selector for "extra specificity" (e.g. a.prc-ActionList-Item[href="/logout"]) — the attribute alone uniquely identifies the element, the class adds no disambiguation, and framework-generated class names like Primer's prc-* or emotion-* change between releases. Use just a[href="/logout"] instead.

   Step C — disambiguation by scope, not position. If multiple elements match your selector, prefer scoping to the nearest meaningful container (a landmark like #main, nav, [role="dialog"], [data-testid="..."]) over reaching for nth=0. Position is fragile; scope is semantic.

   Never in selectors:
   - Tailwind utility classes (.bg-blue-500, .!fixed, .z-[999], .hover:bg-red) — they contain characters that break CSS parsing and change on every design tweak
   - Auto-generated ids like #\\:r1a\\: or #radix-123 — regenerate on every render
   - :nth-child to disambiguate between elements that have unique text or attributes
   - State pseudo-classes (:visible, :hidden, :disabled) — see rule 12; use waitType for state

   Cookbook — canonical patterns:
   - Button with a unique label → button:text-is("Sign in"), or [role="button"][name="Sign in"]
   - Link in a nav with a short label → nav a:text-is("New") (scoped + exact-match)
   - Link to a known route → a[href="/logout"] (attribute alone is sufficient; don't prefix with the class)
   - Input by its label → label:text-is("Email") + input, or input[name="email"] if available
   - Row in a table → tr:has-text("paul@example.com") (substring OK here — the value is specific)
   - Dismissing a dialog → [role="dialog"] button:text-is("Cancel")
   - Icon-only button → [aria-label="Close"]
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. In the DOM snapshot, elements are annotated with their position (e.g. [pos:x,y w×h]) — prefer elements whose position is within the visible viewport and ignore off-screen or zero-size duplicates
5. Only include an "assert" action when the step instruction explicitly asks to verify, check, or confirm something. Do NOT add an assert to confirm that a click or other action succeeded — you will see the result in the next screenshot${dismissalRule}
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, set "condition" to what you're checking and "expected" to the expected value
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
11. For "select" actions, set "selector" to the <select> element itself (NOT an <option>) and "value" to the visible option text (e.g. "Transaction Dispute"). Never click <option> elements directly — always use the "select" action on the parent <select>
12. For "wait" actions, set "waitType" and "condition". IMPORTANT: keep selectors as pure CSS — describe WHAT element, and let "waitType" describe WHAT STATE. Never encode state (visibility, hidden, enabled, disabled, presence) in the selector itself via pseudo-classes like ":visible", ":hidden", ":not(:visible)", ":disabled", ":empty". The framework applies the correct Playwright state automatically based on "waitType", so adding state pseudos to the selector is redundant and commonly fails.
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
19. For "find" actions, set "value" to the text to search for. Returns up to 50 leaf-like matches with stable selectors (auto-chained nth-of-type when the element has no direct id/data-testid/name/aria-label), plus the total match count so you can tell whether more exist than were shown. Optionally set "selector" to a CSS selector that scopes the search to that element's subtree — use this to cut noise when you already know where the target lives (e.g. { "action": "find", "value": "Smith", "selector": "#orders-table" }). Use find when you need to locate a specific item that is not visible in the snapshot — most commonly an item inside an omitted run (see rule 20a). Always set "needs_reeval": true
20. For "expand" actions, set "selector" to the CSS selector of the element to expand. The framework will return the full DOM subtree for that element. Use this when you need to see all descendants of a specific element (e.g. inspecting the cells inside one row of a large table). Always set "needs_reeval": true
20a. Omitted-run markers. The snapshot may contain comments like '<!-- 495 similar <tr> elements omitted (nth-of-type 4..498). Use find "<text>" to locate one, or target directly with tbody > tr:nth-of-type(N). -->'. These mean a long repetitive run (table rows, list items, etc.) was collapsed to head + tail to save space. To act on a specific omitted item: (a) use a "find" action with text you know is inside it and use the returned selector, or (b) if you already know the position, construct an nth-of-type(N) selector from the parent prefix in the marker and use it directly (click / read / expand). Rendered head and tail items use their normal selectors
21. CRITICAL: Complete ONLY what the current step instruction literally asks for. Do NOT perform follow-up actions that belong to subsequent steps, even if they seem like the obvious next thing to do. Each step is deliberately scoped — the test author has split the workflow into separate steps for a reason. Once the instruction is fulfilled, stop
22. Chaining a wait with a triggering action (see rule 2 exception). When the step instruction names a completion condition, pair the triggering action with the matching wait primitive in the same response and set needs_reeval: false — Playwright will block until the condition is met, making the step deterministic and eliminating polling round-trips. Use the narrowest wait type available:
   - Destination URL ("…and wait until the OTP page" / "…until /dashboard loads") → waitType "url", condition = glob like "**/otp"
   - Visible confirmation ("…and wait for the success toast" / "…until the 'Saved' banner appears") → waitType "selector" or "text"
   - List / table populated ("…and wait until the table loads" / "…until results appear") → waitType "count", condition = row selector, expected = "1"
   - Spinner / loader disappears ("…and wait for the loading indicator to disappear") → waitType "hidden", condition = spinner selector
   - Button / field becomes enabled ("…until the Submit button is enabled") → waitType "attribute", selector = the button, expected = "!disabled"
   - Any navigation off the current URL ("…and wait for the page to navigate") → waitType "navigation" (resolves on the FINAL URL of a redirect chain, not the first hop)
   Example — step "Click Login and wait until the OTP page loads":
   { "actions": [
       { "action": "click", "selector": "#login-btn", "description": "Click Login" },
       { "action": "wait", "waitType": "url", "condition": "**/otp", "description": "Wait for OTP page" }
     ], "reasoning": "...", "needs_reeval": false }
   When the instruction does NOT name a completion condition (e.g. just "click Login"), return only the triggering action — do not invent speculative waits`, true),
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

/**
 * Asks the AI to write a self-executing JavaScript snippet that extracts the relevant
 * value(s) from the current page DOM and evaluates whether the assertion passes.
 *
 * The returned code is cached keyed on test name + step index, so subsequent runs
 * execute it directly with no AI call.
 */
export function buildAssertionCodePrompt(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  testInfoSection?: string,
): ChatMessage {
  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  const textContent = `${testInfoBlock}Write a self-executing JavaScript function that evaluates the following test assertion against the current page DOM.

## Assertion
${stepInstruction}

## Current Page DOM (full, uncompacted)
\`\`\`html
${domSnapshot}
\`\`\`

Requirements for the code:
- Must be a self-executing function: \`(() => { ... })()\`
- Must return \`{ pass: boolean, actual: string }\`
- If an element is not found, return \`{ pass: false, actual: "element not found: <selector>" }\` — do NOT throw
- For numeric comparisons, strip currency symbols and commas before parsing
- For cross-element assertions, query each element separately and compare

Respond with ONLY this JSON:
{
  "code": "(() => { ... })()"
}`;

  if (screenshotBase64) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: textContent },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
      ],
    };
  }
  return { role: 'user', content: textContent };
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
