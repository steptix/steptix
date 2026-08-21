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
export interface ActiveBrowserInfo {
  label: string;
  engine: string;
  channel?: string;
  /** Other registered browsers, used to remind the AI which sessions exist
   *  so it doesn't hallucinate a `switchBrowser to=...` against an
   *  unregistered label. Empty array means single-browser mode. */
  others: Array<{ label: string; engine: string; channel?: string }>;
}

export function formatTestInfo(
  testName: string,
  baseUrl?: string,
  currentStep?: number,
  totalSteps?: number,
  viewport?: ViewportInfo,
  browser?: ActiveBrowserInfo,
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
  // Multi-browser grounding. Only emitted when more than one browser is
  // registered, so single-browser tests see no extra noise. The AI uses
  // this to disambiguate which browser a step targets and to avoid
  // hallucinating switchBrowser calls against unknown labels.
  let browserInfo = '';
  if (browser && browser.others.length > 0) {
    const fmt = (b: { label: string; engine: string; channel?: string }) =>
      `${b.label} (${b.engine}${b.channel ? '/' + b.channel : ''})`;
    const all = [
      { label: browser.label, engine: browser.engine, ...(browser.channel !== undefined && { channel: browser.channel }) },
      ...browser.others,
    ].map(fmt).join(', ');
    browserInfo =
      `- Active Browser: ${fmt(browser)}\n` +
      `- All Browsers: ${all}`;
  }
  return [`## Test Information`, `- Test: ${testName}`, baseUrlInfo, stepInfo, viewportInfo, browserInfo]
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
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. In the DOM snapshot, duplicates hidden with display:none or aria-hidden are collapsed to tag-only placeholders marked <!-- hidden: ... --> with their attributes dropped — never target those. When more than one rendered candidate remains, use the screenshot to confirm which variant is actually visible
5. Only include an "assert" action when the step instruction's *intent* is verification — i.e. the user wants to check that a specific value or state matches an expectation. Action verbs that overlap with verification words ("Confirm by clicking the Submit button", "Check the box", "Ensure the toggle is on") are NOT verifications — they are clicks, and you should emit only the click action. Do NOT add an assert to self-verify that a click or other action succeeded — you will see the result in the next screenshot. A failed assert immediately fails the step, so be deliberate${dismissalRule}
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, ALWAYS set "description" (short report label) and "condition" (natural-language statement of what is being checked). The "against" field discriminates four shapes — pick the one that matches the resolved instruction text:
   - against: "dom" (default): the instruction asks you to verify something visible on the page. Set "condition" to what to read (e.g. "visible modal title text") and "expected" to the concrete literal it should equal (e.g. "Done"). Example: { "action": "assert", "against": "dom", "condition": "visible modal title text", "expected": "Done", "description": "Modal title equals Done" }.
   - against: "api": the instruction is purely about a prior API response. Set "condition" to a path/description into that response and "expected" to the literal value at that path. Example: { "action": "assert", "against": "api", "condition": "step_3.response.body.id", "expected": "DEL-1234", "description": "Created delegate id is DEL-1234" }.
   - against: "both": the instruction can reference either DOM or prior API responses. Same field requirements as "dom"/"api".
   - against: "predicate": the instruction is a self-contained predicate — both sides of the comparison are already substituted into the resolved text. Use this whenever NOTHING in the DOM or prior API responses needs to be fetched. Set "condition" to the resolved English predicate verbatim. DO NOT include "expected" — predicate mode rejects it strictly. Triggers: instructions like "Assert that 8 is at least 5", "Assert that 2 equals 2", or 'Assert that ["O-1003","O-1007"] contains "O-1003"' (after parameter substitution leaves only literals on both sides — no DOM, no API). Example: { "action": "assert", "against": "predicate", "condition": "8 is at least 5", "description": "order_count >= 5" }.
   Optional on any mode: "poll": { "timeoutMs": 5000, "intervalMs": 250 } when the instruction implies eventual consistency ("eventually shows", "after a moment") and no deterministic wait primitive fits.
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
   Optional "timeout": the maximum number of MILLISECONDS to wait before the wait fails (default 10000). Raise it when the step states or implies the wait may be slow — e.g. "wait up to 60 seconds", "this can take a while", a known-slow navigation, upload, or background-processing step. Pick a value comfortably above the expected duration (e.g. "timeout": 90000 for a wait that "may take up to 60 seconds"). The framework caps it at 600000 (10 minutes). Only set "timeout" when a longer-than-default wait is warranted; omit it otherwise. Example — step "Click Continue and wait up to 90 seconds for /newurl": { "actions": [ { "action": "click", "selector": "#continue", "description": "Click Continue" }, { "action": "wait", "waitType": "url", "condition": "**/newurl", "timeout": 90000, "description": "Wait up to 90s for navigation to /newurl" } ], "needs_reeval": false }
   If the screenshot shows the page is loading or transitioning (visible spinner, blank content, partially loaded), return a "wait" action to let it settle before proceeding
12a. For "scroll" actions there are THREE forms — pick the one that matches what the step names:
   - A named target ("scroll down to the reviews section") → set "selector" to that element: { "action": "scroll", "selector": "#reviews", "description": "Bring the reviews section into view" }. PREFER this form whenever the step names something to scroll to — it involves no pixel arithmetic at all. Add "frame" when the target is inside an iframe (rule 16); the scroll follows it
   - A page extreme ("scroll to the bottom of the page", "scroll back up to the top") → set "to" to "bottom" or "top": { "action": "scroll", "to": "bottom", "description": "Scroll to the bottom of the page" }. This is absolute and exact at any page height
   - A relative nudge ("scroll down a bit") → set "direction" ("up"|"down"|"left"|"right") and "amount" in pixels: { "action": "scroll", "direction": "down", "amount": 300, "description": "Scroll down a bit" }. This is also the only form that scrolls an inner scrollable pane under the pointer instead of the page — use it as the fallback on layouts that fix the body and scroll an inner element, where "to" will not move
   Sizing a relative scroll: "a bit"/"a little"/"slightly" ≈ 300px; "a page"/"a screenful" ≈ the viewport height given in Test Information. Never approximate an extreme with a large "amount" — use "to" instead, which lands exactly
   Precedence when several fields are present: "selector" wins over "to", and "to" wins over "direction"/"amount". The ignored fields are not an error, so don't retry over them
   VERIFYING A SCROLL. A "Scroll position: <top>–<bottom> of <total>px" line accompanies the DOM snapshot, with "(at top)" / "(at bottom)" / "(page does not scroll)" markers. It is present whether or not screenshots are enabled — read it rather than the image to confirm a scroll landed
   LAZY-LOADING PAGES. "to": "bottom" reaches the CURRENT bottom, which is not the final bottom on a page that loads more content as you scroll. Set "needs_reeval": true, compare the "of <total>px" figure on the next turn, and repeat the same scroll until that total stops growing — then stop
13. For "read" actions, set "selector" to the CSS selector of the element to read and "as" to a snake_case variable name. Use "read" when a step asks you to capture, note, remember, store, or take note of a value from the page (e.g. "capture the residential address", "take note of the balance", "note the email"). If the step specifies a variable name via [store as: name], use that name exactly. Otherwise derive a concise snake_case name from what is being captured (e.g. "residential address" → "residential_address", "account balance" → "account_balance"). Captured values become available as {{variable_name}} in later steps. By default "read" returns the element's value (for inputs) or its textContent. If the step asks for an attribute — most commonly an href, src, or a URL — set "attribute" to the attribute name (e.g. "href"). The displayed text on a link or breadcrumb often differs from the underlying URL, so always use "attribute": "href" when capturing a link URL rather than reading the visible text
13a. CAPTURING A LIST. When a step asks for "every", "all", "each" matching value (e.g. "capture every link under section 1", "read all the row IDs", "get every product's price"), add "multiple": true to the read action. The framework iterates the selector across every match and stores the values as a JSON-encoded array in the variable. Combine with "attribute" to scrape e.g. every href: { "action": "read", "selector": "section.section-1 a[href]", "attribute": "href", "as": "section1_links", "multiple": true, "description": "Capture every link href under section 1" }. The variable can then be passed to a tool that declares an array-typed parameter — for example "[tool: visit-each urls={{section1_links}}]" — which receives a typed string[] and can loop in code. Without "multiple": true, only the first match is captured (single-string behaviour).
13b. EXTRACTING A SUBSTRING from a read. When the step wants only PART of an element's text — e.g. the account number (the digits after the "Account number:" label), just the price, or the order id inside a link URL — add a "pattern" field to the read action: a JavaScript regular expression with ONE capture group around the wanted substring. The framework applies it to the captured text and stores the first capture group (or the whole match when the pattern has no group). Example: an element showing "Account number: 1234 1234 1234 OIN:12345678" → capture just the number with { "action": "read", "selector": "div.account", "as": "account_number", "pattern": "Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" }. Full JavaScript regex syntax is supported. The step FAILS if the pattern is invalid or matches nothing — so only add "pattern" when the step asks for a sub-portion, and make the regex match the actual text. Combine with "attribute" to slice an href/data value, or with "multiple": true to apply the pattern to each element (non-matching elements are dropped)
14. For "count" actions, set "selector" to the CSS selector to count and "as" to a snake_case variable name. Use "count" when a step asks how many elements exist (e.g. "how many accounts", "count the rows"). The result is stored as a string (e.g. "3") and available as {{variable_name}} in later steps
15. Set "needs_reeval": true if the current step instruction is NOT yet fully satisfied after this action. Set false (or omit) when the step instruction IS satisfied. IMPORTANT: only consider the current step instruction — do NOT continue into actions that belong to subsequent steps. For example, if the step says "Enter username and password", set needs_reeval: true after entering the username (you still need to enter the password), but set needs_reeval: false after entering the password — do NOT proceed to click Login unless the step says to
16. For elements inside an <iframe>, set "frame" to the CSS selector of the iframe element (shown in the <!-- comment --> after the <iframe> tag). For **nested iframes** (an iframe inside another iframe), chain the selectors with " >> " from outermost to innermost. Example: if the DOM snapshot shows \`<iframe id="outer"> <!-- #outer -->\n  <iframe id="inner"> <!-- #inner -->\n    <button id="btn">\`, then to click #btn set "frame": "#outer >> #inner", "selector": "#btn". Never put an iframe selector inside the "selector" field — iframe traversal belongs entirely in the "frame" field. Omit "frame" for elements in the main page
17. When the application opens a new window or tab (via window.open or target="_blank"), the framework tracks all open pages. An "Open Pages" section will appear in the prompt listing each page with its label, URL, and title. Use a "switchPage" action to switch context before interacting with another page: { "action": "switchPage", "page": "page:2", "description": "Switch to popup window" }. After switching, all actions execute against that page and the DOM snapshot will reflect it on the next turn (set "needs_reeval": true after switchPage). Use "switchPage" with "main" to return to the original page. Do NOT use switchPage if there is only one page open
18. To close a browser tab or popup window, use a "closePage" action: { "action": "closePage", "page": "page:2", "description": "Close the popup window" }. The "page" field accepts the same identifiers as switchPage: an auto label ("page:2"), a custom label (the name supplied via openPage's "as" field — e.g. "docs"), a URL substring, or a title substring. Prefer the custom label when one was assigned (deterministic, refactor-proof). You cannot close the main page. After closing, the framework automatically switches back to the main page — set "needs_reeval": true to get the updated DOM snapshot. Use this when a step asks to close a tab, window, or popup
18a. To open a brand-new browser tab/window at a URL the test specifies (rather than waiting for the application to spawn one via window.open or a target="_blank" link), use an "openPage" action: { "action": "openPage", "url": "https://docs.example.com", "description": "Open documentation in a new tab" }. The new page is automatically promoted to the active page, so subsequent actions in this step and following steps target it without an explicit switchPage. Use this when a step asks to "open a new tab/window to <URL>", "open <URL> in a new tab", or similar. Always set "needs_reeval": true so the next turn sees the new page's DOM. To return to the original page later, use a "switchPage" action with "main".

18b. NAMING TABS for deterministic switchPage. When a step asks to remember/save/name a tab (e.g. "open <URL> in a new tab and remember it as docs", "open <URL> as the help tab"), include "as": "<snake_case_name>" on the openPage action: { "action": "openPage", "url": "https://docs.example.com", "as": "docs", "description": "Open docs and label as 'docs'" }. Subsequent switchPage actions can then target by exact label: { "action": "switchPage", "page": "docs", "description": "Switch back to docs tab" }. Prefer naming when (a) the test will open multiple tabs with similar titles or URLs, or (b) the test author asked for a specific name. Label rules: lowercase letters/digits/underscore/hyphen, must start with a letter, must NOT be "main" (reserved) or match the auto-generated "page:N" form. Without "as", the tab gets the next auto label (page:2, page:3, ...) and you can switch by URL substring or title substring as before

18c. SECOND BROWSER (Chrome + Edge / multi-actor). When a step says to open another browser, a different browser, an Edge browser, a second user's browser — anything that means a fully-isolated session, not just another tab — emit an "openBrowser" action: { "action": "openBrowser", "as": "<label>", "channel": "msedge", "description": "Open Edge as 'edge'" }. Field rules: "as" is REQUIRED (the label this browser registers under; cannot be "default" — that's reserved for the initial browser). "engine" is optional and defaults to the test's chromium engine; valid values "chromium" | "firefox" | "webkit". "channel" is chromium-only and selects a specific install — "msedge" for Microsoft Edge, "chrome" (default), "chrome-beta", etc. After openBrowser, the new browser is automatically active — do NOT emit a separate switchBrowser. To return to a previously-opened browser, emit { "action": "switchBrowser", "to": "<label>", "description": "..." } — "to" must match a label seen in the "All Browsers" line of the test-info block; unknown labels fail loudly. To release a browser session early, emit { "action": "closeBrowser", "as": "<label>", "description": "..." } — closeBrowser is permissive (closes whatever you point it at, including "default" and the last remaining one); the test runner closes all tracked browsers at test end regardless. Always set "needs_reeval": true after these actions so the next turn sees the new browser's DOM.
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
 * The document scroller's geometry, captured beside the URL each turn.
 * All three values are CSS pixels, as read off `document.scrollingElement`.
 */
export interface ScrollPositionInfo {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** Fractional scroll positions never land on an exact integer — treat anything
 *  within a pixel of an extreme as being at it. */
const SCROLL_EDGE_TOLERANCE_PX = 1;

/**
 * Render the scroll-position line the model reads to tell where the viewport is.
 *
 * The DOM snapshot carries no coordinates, so without this line a scroll has no
 * observable effect in two real configurations: `ai.sendScreenshots: false`
 * (no image at all) and `fullPageScreenshots: true` (the image renders the whole
 * page regardless of scroll position). It is also what lets an infinite-scroll
 * loop terminate — the model watches the total height stop growing.
 */
export function formatScrollPosition(pos: ScrollPositionInfo): string {
  const top = Math.round(pos.scrollTop);
  const total = Math.round(pos.scrollHeight);
  const bottom = Math.min(total, Math.round(pos.scrollTop + pos.clientHeight));

  const markers: string[] = [];
  if (pos.scrollHeight - pos.clientHeight <= 0) {
    markers.push('page does not scroll');
  } else {
    if (pos.scrollTop <= SCROLL_EDGE_TOLERANCE_PX) markers.push('at top');
    if (pos.scrollTop + pos.clientHeight >= pos.scrollHeight - SCROLL_EDGE_TOLERANCE_PX) {
      markers.push('at bottom');
    }
  }
  const suffix = markers.length > 0 ? ` (${markers.join(', ')})` : '';

  return `Scroll position: ${top}–${bottom} of ${total}px${suffix}`;
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
  scrollPosition?: ScrollPositionInfo,
): ChatMessage {
  const historySection =
    conversationHistory.length > 0
      ? `## Prior Steps\n${conversationHistory.join('\n')}\n\n`
      : '';

  const openPagesSection = formatOpenPagesSection(openPages);

  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  // Capture can fail (page mid-navigation) — then there is simply no line,
  // rather than a line that says "undefined".
  const scrollBlock = scrollPosition ? `\n${formatScrollPosition(scrollPosition)}\n` : '';

  const screenshotNote = screenshotBase64
    ? '\n\n[Screenshot is attached as an image — use it to understand the current visual state of the page]'
    : '';

  const textContent = `${testInfoBlock}${historySection}${openPagesSection}## Current Step
${stepInstruction}
${scrollBlock}
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
 * Asks the AI to write a self-executing JavaScript snippet that evaluates a
 * single `assert` action's condition + expected against the current page DOM
 * (and/or prior API responses, depending on `against`).
 *
 * The returned code is cached keyed on (stepIndex, assertIndex, fingerprint),
 * so subsequent runs execute it directly with no AI call.
 */
export function buildAssertionCodePrompt(
  assertDescription: string,
  assertCondition: string,
  assertExpected: string | undefined,
  domSnapshot: string | null,
  screenshotBase64: string | null,
  apiResponseHistory?: string,
  against: 'dom' | 'api' | 'both' | 'predicate' = 'dom',
  testInfoSection?: string,
): ChatMessage {
  const testInfoBlock = testInfoSection ? `${testInfoSection}\n\n` : '';

  // Predicate mode: nothing to fetch — both sides of the comparison are
  // already in `condition`. Skip DOM, screenshot, and API context entirely.
  // The generated JS evaluates the predicate as a self-contained boolean.
  if (against === 'predicate') {
    const predicateText = `${testInfoBlock}Write a self-executing JavaScript function that evaluates the following self-contained predicate.

The predicate's both sides are already present in the condition text — there is NOTHING to fetch from the DOM or from prior API responses. The code must NOT call \`document.*\`, MUST NOT reference any API data, and MUST NOT take any external input. Translate the English predicate directly into a boolean expression over the literals in the condition.

## Assertion
- Description: ${assertDescription}
- Condition: ${assertCondition}

Requirements for the code:
- Must be a self-executing function: \`(() => { ... })()\`
- Must return \`{ pass: boolean, actual: string }\`
- \`actual\` should describe the comparison performed in a single line, e.g. \`"8 >= 5 → true"\` or \`"['O-1003','O-1007'] contains 'O-1003' → true"\`. This is what the report shows under "Result".
- For "contains" / "includes" predicates over a JSON-array literal, parse the array (\`JSON.parse\`) and use \`Array.prototype.includes\`.
- For numeric comparisons, parse the operands as numbers (\`Number(...)\`) before comparing.
- Do NOT throw — return \`{ pass: false, actual: "<why it failed>" }\` for any unexpected shape.

Respond with ONLY this JSON:
{
  "code": "(() => { ... })()"
}`;
    // No screenshot for predicate mode — screenshot was never requested
    // (step-executor skips capture for predicate) and including one would
    // waste tokens on an irrelevant page.
    return { role: 'user', content: predicateText };
  }

  const apiSection = (against !== 'dom' && apiResponseHistory)
    ? `\n\n## Prior API Responses (assertions about API data are evaluated against this section)\n${apiResponseHistory}\n`
    : '';

  const domSection = (against !== 'api' && domSnapshot)
    ? `\n\n## Current Page DOM (full, uncompacted)\n\`\`\`html\n${domSnapshot}\n\`\`\``
    : '';

  const contextNote = against === 'api'
    ? 'The assertion is evaluated against prior API responses, NOT the page DOM. The code must NOT call `document.*` — instead, embed the relevant API response value as a literal string and compare.'
    : against === 'both'
      ? 'The assertion may reference either the page DOM or prior API responses. If referencing API data, embed the relevant value as a literal in the code rather than fetching at runtime.'
      : 'The assertion is evaluated against the current page DOM.';

  const textContent = `${testInfoBlock}Write a self-executing JavaScript function that evaluates the following assertion.

${contextNote}

## Assertion
- Description: ${assertDescription}
- Condition: ${assertCondition}
- Expected: ${assertExpected ?? '(not provided)'}
${domSection}${apiSection}

Requirements for the code:
- Must be a self-executing function: \`(() => { ... })()\`
- Must return \`{ pass: boolean, actual: string }\`
- If an element is not found, return \`{ pass: false, actual: "element not found: <selector>" }\` — do NOT throw
- For numeric comparisons, strip currency symbols and commas before parsing
- For cross-element assertions, query each element separately and compare
- Use ONLY native CSS selectors with \`document.querySelector\` / \`document.querySelectorAll\`. Playwright pseudos (\`:has-text(...)\`, \`:text-is(...)\`, \`:visible\`, \`:text(...)\`) are NOT valid CSS and will throw \`SyntaxError\`. To match elements by text, query a broader set then filter in JS — e.g. \`Array.from(document.querySelectorAll('tr')).find(el => el.textContent.includes('Alice'))\`.

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
  scrollPosition?: ScrollPositionInfo,
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

  // Sits directly under Current URL — the two together are the whole of "where
  // am I" for a turn that has no usable screenshot. Absent, not "undefined",
  // when the capture failed.
  const scrollLine = scrollPosition ? `\n${formatScrollPosition(scrollPosition)}` : '';

  const textContent = `${testInfoBlock}You are continuing the execution of a step.

Original instruction: "${originalInstruction}"

Actions completed so far (turns 1–${turnNumber - 1}):
${actionLines}

Variables captured so far:
${variableLines}

Current URL: ${currentUrl}${scrollLine}

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
