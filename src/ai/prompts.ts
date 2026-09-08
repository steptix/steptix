import type { AIAction, ChatMessage, MessageContentBlock } from './types.js';
import type { ActionTargeting } from '../browser/actions.js';
import type { PageInfo } from '../browser/manager.js';
import type { PageStateDiagnosis } from '../browser/page-state.js';
import { parseFlowControlStep } from '../parser/flow-control-step.js';
import { isSecretName, isSecretRef, MASK } from '../utils/secrets.js';

/**
 * What a step's placeholders hold right now — the `## Values` block the model
 * reads beside the step's AUTHORED text
 * (stories/placeholder-preserving-actions.md, decision 1).
 *
 * The step prompt shows `Enter the email {{email}}` and this table, and the
 * model puts `{{email}}` — not the value — in the field it filled from it.
 * Rendered by {@link formatParameterBlock}, the formatter the generation
 * prompt already uses, so a reference is described identically wherever the
 * model meets it.
 */
export interface StepValues {
  /** Every `{{name}}` the step references, with this run's value. A name the
   *  step DEFINES (`store as {{balance}}`, `[as: x]`) is not a reference and
   *  does not belong here. */
  parameters: Array<{ name: string; value: string }>;
  /** Every `${env.X}` / `${data.X.Y}` / `${source.X}` the step references,
   *  with what it resolved to in this environment. */
  envRefs?: Array<{ ref: string; value: string }>;
  /** Names and refs the test has declared are not secrets, despite
   *  `isSecretName` matching them (the per-test `## Config` hatch). */
  unmask?: ReadonlySet<string>;
}

/** The `## Values` block, or '' when the step references nothing — absence is
 *  what keeps a plain step's prompt byte-identical to the one built before
 *  this block existed. */
function formatValuesBlock(values?: StepValues): string {
  if (!values) return '';
  const { parameters, envRefs = [] } = values;
  if (parameters.length === 0 && envRefs.length === 0) return '';
  return formatParameterBlock(parameters, envRefs, values.unmask ?? new Set<string>());
}

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
4. Many pages render duplicate elements for mobile and desktop layouts. Use the viewport size and device mode (see Test Information) to target the correct variant. In the DOM snapshot, duplicates hidden with display:none or aria-hidden are collapsed to tag-only placeholders marked <!-- hidden: ... --> with their attributes dropped — never target those. ONE exception: a hidden \`<input type="file">\` keeps its attributes and IS a valid target — that is what a styled uploader looks like, and rule 10a covers it. When more than one rendered candidate remains, use the screenshot to confirm which variant is actually visible
5. Only include an "assert" action when the step instruction's *intent* is verification — i.e. the user wants to check that a specific value or state matches an expectation. Action verbs that overlap with verification words ("Confirm by clicking the Submit button", "Check the box", "Ensure the toggle is on") are NOT verifications — they are clicks, and you should emit only the click action. Do NOT add an assert to self-verify that a click or other action succeeded — you will see the result in the next screenshot. A failed assert immediately fails the step, so be deliberate${dismissalRule}
7. If you cannot determine what to do, return a single "prompt" action with a "question" field
8. For "assert" actions, ALWAYS set "description" (short report label) and "condition" (natural-language statement of what is being checked). The "against" field discriminates four shapes — pick the one that matches the resolved instruction text:
   - against: "dom" (default): the instruction asks you to verify something visible on the page. Set "condition" to what to read (e.g. "visible modal title text") and "expected" to the concrete literal it should equal (e.g. "Done"). Example: { "action": "assert", "against": "dom", "condition": "visible modal title text", "expected": "Done", "description": "Modal title equals Done" }.
   - against: "api": the instruction is purely about a prior API response. Set "condition" to a path/description into that response and "expected" to the literal value at that path. Example: { "action": "assert", "against": "api", "condition": "step_3.response.body.id", "expected": "DEL-1234", "description": "Created delegate id is DEL-1234" }.
   - against: "both": the instruction can reference either DOM or prior API responses. Same field requirements as "dom"/"api".
   - against: "predicate": the instruction is a self-contained predicate — everything either side of the comparison is in the step text itself, whether written as a literal or as a placeholder listed under "## Values". Use this whenever NOTHING in the DOM or prior API responses needs to be fetched. Set "condition" to the predicate AS WRITTEN, placeholders included — the framework substitutes them before the check is generated, so do not resolve them yourself. DO NOT include "expected" — predicate mode rejects it strictly. Triggers: instructions like "Assert that {{order_count}} is at least 5", "Assert that 8 is at least 5", "Assert that 2 equals 2", or 'Assert that ["O-1003","O-1007"] contains "O-1003"' (nothing to read from the page or from an API). Example: { "action": "assert", "against": "predicate", "condition": "{{order_count}} is at least 5", "description": "order_count >= 5" }.
   Optional on any mode: "poll": { "timeoutMs": 5000, "intervalMs": 250 } when the instruction implies eventual consistency ("eventually shows", "after a moment") and no deterministic wait primitive fits.
8a. PLACEHOLDERS — name the value you used, do not copy it. A name listed under "## Values" is a placeholder: the step text shows it as {{email}} or \${data.url}, and the block says what it holds on this run. When a value you type, upload, navigate to, select by, press, send or expect came from one, write the PLACEHOLDER in that field and not the value it holds — "value", "filePath", "filePaths", "url", "selector", "key", "expected", an api_call's "body" and "apiHeaders", and a predicate "condition". The framework substitutes it at the moment it acts, so the page still receives the real value; naming it is what lets this step be re-run with a different one. Never put a placeholder in "description" — that is your own words about what you did. A placeholder that follows "store as" or "save as" names a variable you are DEFINING: it belongs in "as", it is not a reference, and it will not be listed under "## Values". "***" is a mask over a secret value, never a value to type — write the placeholder and the framework types the real thing. Only the names listed under "## Values" are placeholders: a literal "{{count}}" you can see rendered in the page is that page's text, and a step that writes "\\{{count}}" means those characters literally.
   Example — step "Enter the email {{email}}", with "## Values" listing {{email}}: { "action": "type", "selector": "#email", "value": "{{email}}", "description": "Enter the email address" }. NOT "value": "demo@securebank.com".
   Counter-example — step "Verify {{outcome}}", where "## Values" shows {{outcome}} holds the sentence "the Dashboard page is shown": that sentence is not a value to put in a field, it is something to interpret, so read it and assert what it describes — { "action": "assert", "against": "dom", "condition": "visible page heading", "expected": "Dashboard", "description": "Dashboard page is shown" }. A placeholder goes in a field only when that field is filled FROM its value.
9. For "navigate" actions, set "url" to the full or relative URL
10. For "type" actions, set "value" to the text to type
10a. UPLOADING A FILE. A step that names a file PATH — a token with a file extension or a folder separator, e.g. "Upload file \\attachments\\logo.png", "Attach receipt-1.png and receipt-2.png", "Use the Choose file button to upload id.pdf" — is an upload. (A "choose"/"select" with no path is a dropdown: rule 11.) Emit an "upload" action: { "action": "upload", "selector": "#statement-file", "filePath": "attachments/logo.png", "description": "Upload logo.png as the statement" }.
   "filePath" RULES: copy the path exactly as the step wrote it, with backslashes turned into forward slashes and NO leading slash — write "attachments/logo.png", never "\\attachments\\logo.png" (a lone backslash is invalid JSON and costs the whole turn), and never an absolute path like "C:/Users/...". Do NOT guess a folder and do NOT check whether the file exists: the framework resolves the path against the test file's own folder and fails the step itself, with a clear message, if it is missing. For SEVERAL files into one field use "filePaths": ["attachments/receipt-1.png", "attachments/receipt-2.png"] instead of "filePath".
   "selector" RULES: when the step names a control — "use the Choose file button", "click Browse", "drop it on the upload area" — target THAT control; the framework clicks it and answers the file picker it opens. When the step names no control, target the field's <input type="file">. A file input shown as \`<input id="..." type="file"> <!-- hidden: display:none -->\` is NORMAL for a styled uploader and is still the right target (the exception to rule 4) — do not try to make it visible first. Never "type" a path into a text field, and never "click" a file input.
   A separate click on the Upload/Submit button the step names is still its own "click" action after the upload. Do not add a "wait" after an upload unless the step names a completion condition (rule 22)
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
13. For "read" actions, set "selector" to the CSS selector of the element to read and "as" to a snake_case variable name. Use "read" when a step asks you to capture, note, remember, store, or take note of a value from the page (e.g. "capture the residential address", "take note of the balance", "note the email"). If the step specifies a variable name via [store as: name], use that name exactly. Otherwise derive a concise snake_case name from what is being captured (e.g. "residential address" → "residential_address", "account balance" → "account_balance"). Captured values become available as {{variable_name}} in later steps. By default "read" returns the element's value (for inputs) or its textContent. If the step asks for an attribute — most commonly an href, src, or a LINK's URL — set "attribute" to the attribute name (e.g. "href"); for the address of the page itself, see 13c. The displayed text on a link or breadcrumb often differs from the underlying URL, so always use "attribute": "href" when capturing a link URL rather than reading the visible text
13a. CAPTURING A LIST. When a step asks for "every", "all", "each" matching value (e.g. "capture every link under section 1", "read all the row IDs", "get every product's price"), add "multiple": true to the read action. The framework iterates the selector across every match and stores the values as a JSON-encoded array in the variable. Combine with "attribute" to scrape e.g. every href: { "action": "read", "selector": "section.section-1 a[href]", "attribute": "href", "as": "section1_links", "multiple": true, "description": "Capture every link href under section 1" }. The variable can then be passed to a tool that declares an array-typed parameter — for example "[tool: visit-each urls={{section1_links}}]" — which receives a typed string[] and can loop in code. Without "multiple": true, only the first match is captured (single-string behaviour).
13b. EXTRACTING A SUBSTRING from a read. When the step wants only PART of an element's text — e.g. the account number (the digits after the "Account number:" label), just the price, or the order id inside a link URL — add a "pattern" field to the read action: a JavaScript regular expression with ONE capture group around the wanted substring. The framework applies it to the captured text and stores the first capture group (or the whole match when the pattern has no group). Example: an element showing "Account number: 1234 1234 1234 OIN:12345678" → capture just the number with { "action": "read", "selector": "div.account", "as": "account_number", "pattern": "Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" }. Full JavaScript regex syntax is supported. The step FAILS if the pattern is invalid or matches nothing — so only add "pattern" when the step asks for a sub-portion, and make the regex match the actual text. Combine with "attribute" to slice an href/data value, or with "multiple": true to apply the pattern to each element (non-matching elements are dropped)
13c. CAPTURING THE PAGE'S OWN URL. "Capture the current page URL", "note where we are", "remember this address" is not an attribute of any element — no element carries it. Use "attribute": "url" with any selector that is certainly present, normally "body": { "action": "read", "selector": "body", "attribute": "url", "as": "target_url", "description": "Capture the current page URL" }. It returns the address shown above as Current URL. Do NOT reach for "href" here — that is the destination of a link, not the page you are on — and do NOT read an element's text hoping it spells out the URL. A real "url" attribute, where a page carries one, still wins over the page address. Combining it with "multiple": true is pointless — every match yields the same page address
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
   When the instruction does NOT name a completion condition (e.g. just "click Login"), return only the triggering action — do not invent speculative waits
23. LEAVING A FLOW EARLY. Some steps are written as flow control: "If <condition> then return", "When <condition> then stop", "If <condition> then stop running the remaining steps", and the compound form "If the Save button is visible, click it and return". On such a step, judge the condition against the page. If it HOLDS, return { "action": "return", "description": "<why the condition holds>", "needs_reeval": false } — after any action the step also asks for, in the same response. If it does NOT hold, return { "action": "noop", "description": "<why the condition does not hold>", "needs_reeval": false } and the next step will run. NEVER return "return" on a step that does not say to return or stop: the framework rejects it and the step fails. A step that merely mentions going back ("Click the details link then return", "Navigate back") is an ordinary browser step, not flow control`, true),
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
 *
 * `stepInstruction` is the step as AUTHORED where the caller has that form:
 * `{{name}}` and `${…}` intact, with `values` saying what each one holds
 * (stories/placeholder-preserving-actions.md, decision 1). The `## Values`
 * block sits between the step and the DOM, and is absent when the step
 * references nothing — a plain step's prompt is then byte-identical to the one
 * this function built before the block existed, which is what makes the change
 * additive for every test that uses no parameters.
 */
export function buildStepMessage(
  stepInstruction: string,
  domSnapshot: string,
  screenshotBase64: string | null,
  conversationHistory: string[],
  openPages?: PageInfo[],
  testInfoSection?: string,
  scrollPosition?: ScrollPositionInfo,
  values?: StepValues,
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

  // Absent, not empty, when the step references nothing — see the doc comment.
  const valuesText = formatValuesBlock(values);
  const valuesBlock = valuesText ? `\n## Values\n${valuesText}\n` : '';

  const textContent = `${testInfoBlock}${historySection}${openPagesSection}## Current Step
${stepInstruction}
${scrollBlock}${valuesBlock}
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
 *
 * `values` replaces the raw `name = "value"` rendering of the WHOLE resolved
 * parameter map with the same masked `## Values` table turn 1 carries, scoped
 * to what this step references (stories/placeholder-preserving-actions.md,
 * decision 2). It was the widest of the three surfaces a secret reached: every
 * continuation turn of every step rendered every parameter, unmasked, whether
 * the step referenced it or not.
 *
 * `capturedVariables` is the pre-`values` form and is used only when `values`
 * is absent, so callers that have not been threaded yet keep today's block
 * rather than losing it. Once every caller passes `values`, the parameter and
 * this fallback go.
 *
 * `authoredInstruction` is the step as written, placeholders intact — what the
 * two echoes of the instruction should show when the caller has that form.
 * Defaults to `originalInstruction`.
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
  values?: StepValues,
  authoredInstruction?: string,
): ChatMessage {
  const instructionText = authoredInstruction ?? originalInstruction;

  const actionLines = completedActions.length > 0
    ? completedActions.map((a) => `  - ${a.description}`).join('\n')
    : '  (none)';

  const legacyVariableLines = Object.entries(capturedVariables).length > 0
    ? Object.entries(capturedVariables).map(([k, v]) => `  ${k} = "${v}"`).join('\n')
    : '  (none)';

  // The masked table when the caller has one, today's unmasked map when it
  // does not. Under turn 1's heading, because the system prompt's placeholder
  // rule is written in terms of "the names listed under ## Values" and a turn
  // that named the block something else would put its placeholders outside it.
  const valuesSection = values
    ? `## Values\n${formatValuesBlock(values) || '  (none)'}`
    : `Variables captured so far:\n${legacyVariableLines}`;

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

Original instruction: "${instructionText}"

Actions completed so far (turns 1–${turnNumber - 1}):
${actionLines}

${valuesSection}

Current URL: ${currentUrl}${scrollLine}

${openPagesSection}${explorationSection}## DOM Snapshot
\`\`\`html
${domSnapshot}
\`\`\`${screenshotBase64 ? '\n\n[Screenshot is attached as an image — use it to understand the current visual state of the page]' : ''}

What is the next action needed to complete the original instruction: "${instructionText}"?
Return ONE action. Set needs_reeval: false if this instruction is now fully satisfied — do NOT continue into actions that belong to subsequent steps. If the instruction is already satisfied and no further action is required, return { "action": "noop", "description": "<why nothing is needed>", "needs_reeval": false }. If the instruction says to return or stop and its condition holds, return { "action": "return", "description": "<why the condition holds>", "needs_reeval": false } instead; if it does not hold, "noop". Never "return" on an instruction that does not say to.`;

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
 *
 * `instruction` MUST be the MASKED substituted text — `redact(interpolated,
 * secretsNow())` — not the raw substituted text and not the authored one
 * (stories/placeholder-preserving-actions.md, decision 2). Substituted,
 * because the history says what actually happened on the page and a later
 * step reads it as evidence; masked, because this block is the surface that
 * carried the password to the model on every step AFTER the one that typed
 * it, so masking the step prompt alone would change nothing. The runners own
 * that call — the entry is built where `secretsNow()` is, and this function
 * cannot mask what it is handed without the run's secrets.
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

/**
 * One transcript action as generation reads it: what the AI asked for, plus
 * what the runtime MEASURED when it ran it
 * (stories/codebehind-selector-ambiguity.md).
 *
 * The same shape `RecordedAction` has in src/codebehind/recording.ts, spelled
 * structurally here so the prompt layer keeps its one-way dependency on the
 * code-behind one. `targeting` is absent far more often than not — it is
 * measured only in a compile mode, and only for element-targeting actions —
 * and its absence is first-class: a transcript without it builds exactly the
 * prompt it built before the measurement existed.
 */
export type TranscriptAction = AIAction & { targeting?: ActionTargeting };

/**
 * Actions whose runtime target is ONE element, so a `matchCount` above 1 is a
 * problem for the entry generated from them rather than the point of it.
 *
 * Mirrors `singularTargetOf` in src/browser/actions.ts. The distinction is
 * load-bearing on both sides of generation: `read multiple` and `count` record
 * a `matchCount` too — useful context for the loop being written — and many
 * matches is their whole purpose, so neither the prompt rule nor the static
 * backstop may read their count as ambiguity.
 */
const SINGULAR_TARGET_ACTIONS: ReadonlySet<AIAction['action']> = new Set([
  'click',
  'type',
  'select',
  'hover',
  'upload',
  'read',
]);

/** Did this action target one element? See {@link SINGULAR_TARGET_ACTIONS}. */
export function isSingularTarget(action: TranscriptAction): boolean {
  return SINGULAR_TARGET_ACTIONS.has(action.action) && action.multiple !== true;
}

/** What `buildStepCodePrompt` needs to describe a successful step to the model. */
export interface StepCodePromptInput {
  /** The step's raw markdown text, `{{param}}` placeholders intact. */
  rawStepText: string;
  /** Parameter names and their resolved values for this run, so the model can
   *  map literals it sees in the transcript back to `step.getVar` calls. */
  parameters: Array<{ name: string; value: string }>;
  /**
   * The environment references the step makes — `${data.url}`, `${env.X}`,
   * `${<source>.path}` — each with what it resolved to on this run. The name
   * inside the braces is the `step.getVar` name that reads it at run time
   * (stories/codebehind-env-data.md); the value is this environment's, and
   * is as much a literal to keep out of the file as a parameter's.
   */
  envRefs?: Array<{ ref: string; value: string }>;
  /** The successful run's action transcript — the same actions the step cache
   *  stores, selectors included, each carrying the `targeting` the runtime
   *  measured for it when there was one. */
  actions: TranscriptAction[];
  /** Assertions the step evaluated, with what they saw. */
  assertions?: Array<{
    condition: string;
    expected?: string | undefined;
    actual?: string | undefined;
    pass: boolean;
  }>;
  /** `[as: x]` / `[store as: x]` capture names the step is expected to write. */
  captures?: string[];
  /** `formatTestInfo(...)` output, when the caller has it. */
  testInfoSection?: string | undefined;
  /**
   * Every step in the test, marked with whether it is being compiled in this
   * pass. Compile's whole-test context: a step cannot reuse step 2's selector
   * in step 5 without seeing step 2 (stories/codebehind-compile.md, "Generate").
   */
  wholeTest?: Array<{ index: number; text: string; inScope: boolean; isThisStep: boolean }>;
  /** The candidate `.steps.ts` as it stands — existing entries plus the ones
   *  generated earlier in this pass — so selectors and helpers stay consistent. */
  candidateFile?: string | undefined;
  /** Page state before the step ran. */
  domBefore?: string | undefined;
  urlBefore?: string | undefined;
  /** Page state after the step ran — what a post-condition must assert. */
  domAfter?: string | undefined;
  urlAfter?: string | undefined;
  /**
   * The one re-ask the static backstop buys
   * (stories/codebehind-selector-ambiguity.md, "The static backstop"): the
   * entry that was refused, and why. Present only on that second call, and
   * never on a third — the backstop asks again once and then takes what it
   * gets.
   */
  retry?: { previousEntry: string; complaint: string };
}

/**
 * The "Parameters in scope" block of the generation and repair prompts, and
 * the `## Values` block of the step and continuation prompts: each `{{name}}`
 * with its value on this run, then each environment reference with its value
 * and the `step.getVar` call that reads it. One formatter, so no two prompts
 * can describe the same reference two ways
 * (stories/placeholder-preserving-actions.md, "Prompt").
 *
 * Secret-named entries render as `"***"` (decision 2). By NAME for a
 * `{{name}}` — `isSecretName` — and by PATH for a `${…}` reference, so
 * `${data.secrets.smtp.host}` masks exactly as `envDataSecretValues` masks its
 * value. The model never needs a secret's value to name the placeholder that
 * holds it, and masking here is what makes the CLI and TestBench compiles
 * agree: only the CLI's was masked before, by the accident of reading
 * `report.parameters` after `redactReport`.
 *
 * `unmask` is the per-test escape hatch: names (and refs) the author has
 * declared are not secrets after all, because `isSecretName` matches `key`
 * and a `keyword` column the model must find in the DOM is a real casualty.
 */
export function formatParameterBlock(
  parameters: Array<{ name: string; value: string }>,
  envRefs: Array<{ ref: string; value: string }>,
  unmask: ReadonlySet<string> = new Set<string>(),
): string {
  if (parameters.length === 0 && envRefs.length === 0) return '(this step uses no parameters)';
  const show = (secret: boolean, name: string, value: string): string =>
    JSON.stringify(secret && !unmask.has(name) ? MASK : value);
  return [
    ...parameters.map(
      (p) => `- {{${p.name}}} resolved to ${show(isSecretName(p.name), p.name, p.value)} on this run`,
    ),
    ...envRefs.map(
      (r) =>
        `- \${${r.ref}} resolved to ${show(isSecretRef(r.ref), r.ref, r.value)} on this run — read it with ` +
        `step.getVar(${JSON.stringify(r.ref)}); the value differs per environment`,
    ),
  ].join('\n');
}

/**
 * Rule 8 as it stood before anything was measured: advice, and a question the
 * model cannot answer from its evidence.
 *
 * Kept verbatim for a transcript carrying no `targeting` at all, which is the
 * fallback whenever measurement was impossible. Absence is first-class and
 * must read as normal rather than as an error
 * (stories/codebehind-selector-ambiguity.md, "What generation does with it").
 */
const SELECTOR_RULE_INFERRED =
  `8. **A transcript selector is not evidence that it matches one element.** The recorded actions ran through a visible-only filter and took the first match, so a selector that worked there may match several — while the same selector in generated code is strict and throws on the second one ("resolved to N elements"). Use a handle the DOM above shows to be unique: a role with its accessible name, an \`id\`, a \`data-testid\`. Where the DOM cannot settle it, reproduce the runtime's own tolerance rather than guessing — \`page.locator(sel).locator('visible=true').first()\`.`;

/**
 * What `targeting` is, said once, above the transcript that carries it.
 *
 * The model is told what the object MEANS rather than left to infer it from
 * four field names — and told where the number came from, because the whole
 * point is that it did not come from the DOM below. That snapshot is
 * truncated, attribute-allowlisted, collapse-elided and strips hidden
 * elements' attributes, so it cannot answer "how many match" and every loss
 * in it biases toward under-counting.
 */
function targetingLegend(actions: TranscriptAction[]): string {
  if (!actions.some((a) => a.targeting !== undefined)) return '';
  return (
    `An action carrying a \`targeting\` object was MEASURED in the live page at the instant the runtime acted on it. These are facts, not proposals — and they are not readable from the DOM below, which is truncated, attribute-filtered and strips hidden elements' attributes:\n\n` +
    `- \`matchCount\` — elements the selector matched, hidden ones included. This is the number strict mode counts, so it is the one that decides whether your entry throws.\n` +
    `- \`visibleMatchCount\` — how many of those were visible: what the runtime chose between when it took the first.\n` +
    `- \`resolvedSelector\` — a selector for the element that was actually acted on, verified in the page to match it and nothing else.\n` +
    `- \`resolvedBy\` — how that handle was built: \`attribute\` (the element's own id / data-testid / name / aria-label / href), \`scoped\` (that same handle qualified by an addressable ancestor), \`positional\` (an \`nth-of-type\` chain).\n\n` +
    `An \`upload\` action also carries \`upload.via\`: \`"input"\` means the files were set straight onto an \`<input type="file">\`, \`"chooser"\` means a control was clicked and the picker it opened was answered. Write whichever shape the transcript shows.\n\n` +
    `An action with no \`targeting\` was not measured. Nothing follows from its absence.\n\n`
  );
}

/**
 * Rules 8 and 9 for a transcript that WAS measured — the inference replaced by
 * the number, and the data-driven carve-out keyed on `resolvedBy`.
 *
 * Each clause is emitted only when the transcript can trigger it: a step whose
 * every selector matched once is not lectured about ambiguity, and a step with
 * no positional handle is not told what to do with one. The rules are read by
 * a model on every compile, so a branch that cannot apply is pure cost.
 *
 * Undefined when the measurement says nothing this rule can key off — a
 * `targeting` carrying neither a count nor a `resolvedBy`. The caller then
 * falls back to the inferred rule, because a rule heading over no clauses
 * would claim a measurement the transcript does not carry.
 */
function measuredSelectorRules(actions: TranscriptAction[]): string | undefined {
  // Counts only mean "ambiguous" for an action that targeted ONE element.
  const singular = actions.filter(isSingularTarget);
  const ambiguous = singular.some((a) => (a.targeting?.matchCount ?? 0) > 1);
  const single = singular.some((a) => a.targeting?.matchCount === 1);
  const plural = actions.some((a) => !isSingularTarget(a) && a.targeting?.matchCount !== undefined);
  const unmeasured = actions.some((a) => a.selector !== undefined && a.targeting === undefined);
  const resolvedBy = new Set(
    actions.map((a) => a.targeting?.resolvedBy).filter((by) => by !== undefined),
  );
  if (!ambiguous && !single && !plural && resolvedBy.size === 0) return undefined;

  const counts = [
    `8. **How many elements each selector matched is measured for you above. Do not re-decide it from the DOM.**`,
    ambiguous
      ? `   - \`matchCount\` above 1 — that selector is NOT usable as written. Use that action's \`resolvedSelector\` verbatim, or reproduce the runtime's own tolerance explicitly: \`page.locator(<the transcript selector>).locator('visible=true').first()\`. There is no third option, and "it looks unique in the DOM" is not one of them.`
      : '',
    single
      ? `   - \`matchCount\` of 1 — that selector matched exactly one element. Use it as written.`
      : '',
    plural
      ? `   - On a \`read\` with \`multiple\` or a \`count\`, \`matchCount\` is context for the loop you are writing, not a problem: many matches is what those actions are for.`
      : '',
    unmeasured
      ? `   - An action with no \`targeting\` was not measured: prefer a stable handle (a role with its accessible name, an \`id\`, a \`data-testid\`), and where you cannot tell, reproduce the runtime's tolerance rather than guessing.`
      : '',
  ].filter(Boolean).join('\n');

  if (resolvedBy.size === 0) return counts;

  const handles = [
    `9. **\`resolvedBy\` says which kind of handle \`resolvedSelector\` is — never work that out from the string.** An author's own selector can contain \`nth-of-type\`, and a scoped handle never does.`,
    resolvedBy.has('attribute') || resolvedBy.has('scoped')
      ? `   - \`attribute\` and \`scoped\` are stable handles: use them directly. \`scoped\` (\`#statements a[href="transactions.html"]\`) is the ordinary answer when a hidden duplicate exists, not a second-best one — insert a sibling above that panel and it still points at the same element.`
      : '',
    resolvedBy.has('positional')
      ? `   - \`positional\` means an \`nth-of-type\` chain was the only thing that verified. If the step text or one of its parameters names what distinguishes the element ("click the row for {{customer}}"), build the locator from that value — \`step.getVar('customer')\` with a text filter or a scoped selector — instead of pinning this run's index. The index is this run's DATA, and this file is committed and re-run for years: next run's customer is a different row. Where nothing in the step distinguishes the element, the positional chain is the right answer.`
      : '',
  ].filter(Boolean).join('\n');

  return `${counts}\n${handles}`;
}

/** A `{{name}}` or `${…}` the model left in a field, in the wider grammar the
 *  act-time check uses — `{{ email }}` and `{{Email}}` are placeholders too. */
const PLACEHOLDER_IN_FIELD = /\{\{\s*\w+\s*\}\}|\$\{[^}]+\}/;

/**
 * The one clause `resolvedSelector` cannot be allowed to overrule
 * (stories/placeholder-preserving-actions.md, "Generator and compile").
 *
 * Targeting measures the SUBSTITUTED selector, so `text={{plan}}` is measured
 * as `text=Premium` and comes back with a concrete `attribute` handle for row
 * 1's element. Following the ordinary rule there would bake row 1's target
 * back into the code the placeholder existed to free. Emitted only when a
 * recorded selector actually carries a placeholder — a rule the transcript
 * cannot trigger is pure cost on every compile.
 *
 * Indented as a sub-clause on purpose: `buildStepCodePrompt` computes the
 * post-condition rule's number from the last `^N. ` line of the selector
 * rules, so a new numbered rule here would shift it.
 */
function placeholderSelectorRule(actions: TranscriptAction[]): string {
  const carries = actions.some((a) => a.selector !== undefined && PLACEHOLDER_IN_FIELD.test(a.selector));
  if (!carries) return '';
  return (
    `\n   - A selector that CARRIES A PLACEHOLDER (\`text={{plan}}\`, \`#row-\${data.id}\`) is built from that ` +
    `value: rebuild it from \`step.getVar('plan')\` whatever \`resolvedBy\` says. Its \`resolvedSelector\` was ` +
    `measured on the substituted form, so it names THIS run's element and is advisory only here.`
  );
}

/** The six actions `ctx.tabs` and `ctx.browsers` cover. */
const TAB_ACTIONS: ReadonlySet<string> = new Set([
  'openPage', 'switchPage', 'closePage', 'openBrowser', 'switchBrowser', 'closeBrowser',
]);
/** The two that can leave the entry with no page to assert on. */
const CLOSING_ACTIONS: ReadonlySet<string> = new Set(['closePage', 'closeBrowser']);

/**
 * Rule 7a: the stale-handle rule, emitted only for a transcript that actually
 * moved a tab or a browser (stories/codebehind-framework-actions.md).
 *
 * Numbered `7a` rather than `8` because the selector rules below are numbered
 * from 8 and the post-condition rule's number is COMPUTED from the last one
 * they emit — inserting a rule 8 here would collide with them and shift a
 * number the computation depends on.
 *
 * A rule the transcript cannot trigger is pure cost on every compile, so a
 * step that touched no tab never sees it. Same principle as
 * `measuredSelectorRules`.
 */
function tabHandleRule(actions: TranscriptAction[]): string {
  if (!actions.some((a) => TAB_ACTIONS.has(a.action))) return '';
  return (
    `\n7a. **After a tab or browser switch, use the handle the switcher returned — never \`page\`.** ` +
    `\`run({ page })\` destructures, and destructuring reads once: \`page\` is bound to whichever tab was ` +
    `active when \`run\` was called, and stays bound to it. So this is wrong, and it does not throw — it ` +
    `drives the tab the step left and passes:\n` +
    `\`\`\`ts\nawait tabs.switchTo('page:2');\nawait page.getByRole('heading').waitFor();  // the OLD tab\n\`\`\`\n` +
    `Write it this way instead:\n` +
    `\`\`\`ts\nconst opened = await tabs.switchTo('page:2');\nawait opened.getByRole('heading').waitFor();\n\`\`\`\n` +
    `\`tabs.open\`, \`tabs.openedBy\`, \`tabs.switchTo\`, \`tabs.close\`, \`browsers.open\` and ` +
    `\`browsers.switchTo\` all return the page that is active afterwards. Using \`page\` BEFORE the first ` +
    `switch is correct — that is where \`tabs.openedBy(() => page.click(...))\`'s trigger lives.`
  );
}

/**
 * The post-condition rule's carve-outs for steps whose result is not on a
 * page (stories/codebehind-framework-actions.md).
 *
 * Two cases where the plain rule asks for something that cannot exist. A step
 * that CLOSED something has no page left to assert on — checking the one it
 * closed is the obvious wrong move. And a freshly-opened browser sits on
 * `about:blank`: its step succeeded when the browser exists and is active, and
 * an entry that waits for content there flakes or hangs.
 *
 * `switchBrowser` deliberately gets no carve-out — the browser you switched TO
 * has real content, so the ordinary rule applies to the page it returned.
 */
function trackerPostCondition(actions: TranscriptAction[]): string {
  const clauses: string[] = [];
  if (actions.some((a) => CLOSING_ACTIONS.has(a.action))) {
    clauses.push(
      `For a step that CLOSES a tab or a browser, the post-condition is that it is gone — assert over ` +
        `\`tabs.list()\` or \`browsers.list()\`, or check the page you were returned to, not the one you closed.`,
    );
  }
  if (actions.some((a) => a.action === 'openBrowser')) {
    clauses.push(
      `For a step that OPENS a browser, the post-condition is that the browser exists and is active — ` +
        `\`browsers.list()\` or \`browsers.activeLabel()\`. A new browser is on \`about:blank\` until ` +
        `something navigates it, so do not wait for page content there.`,
    );
  }
  return clauses.length > 0 ? ` ${clauses.join(' ')}` : '';
}

/**
 * The `step.exit()` bullet, for a step that claims the flow-control form
 * (stories/step-flow-control.md, decision 11).
 *
 * Gated, like every other conditional clause in this prompt: a step that
 * cannot use `exit` is not told it exists, and an ordinary step's prompt stays
 * byte-identical to the one built before this existed.
 */
const FLOW_CONTROL_API =
  '\n- `step.exit()` — end the flow this step is in, as a pass. It throws, so nothing after it runs.';

/**
 * The one rule a flow-control step adds (stories/step-flow-control.md,
 * decision 11).
 *
 * Numbered `Na` off the post-condition rule rather than `N+1`, for the reason
 * `tabHandleRule` is `7a`: the post-condition number is COMPUTED from the last
 * numbered line of the selector rules, and a new whole number here would
 * collide with it. It sits directly after that rule because what it mostly
 * does is except this step from it.
 *
 * The transcript is named explicitly, because it is the trap. A recording shows
 * only the branch this run took — a `return` action or a `noop` — and a model
 * writing "what the transcript did" would emit an entry that returns every time
 * or one that never returns. Either is right on the recording run and wrong on
 * the next.
 */
function flowControlRule(number: number): string {
  return (
    `\n\n${number}a. **This step is a flow-control step: evaluate its condition and call \`step.exit()\` when it holds.** ` +
    `Its text says to return (or stop) under a condition, so the entry reads that condition off the page and exits ` +
    `only if it is true — and does nothing at all if it is not:\n` +
    '```ts\nif ((await page.title()).includes(\'Dashboard\')) step.exit();\n```\n' +
    `Write BOTH branches from the step's own words, never from what this run happened to do: a \`return\` action in ` +
    `the transcript means the condition HELD on the recording run, a \`noop\` means it did NOT, and the entry you ` +
    `write is the same \`if\` either way. It is judged afresh on every future run. An entry that exits ` +
    `unconditionally, or one that never exits, is right on this run and wrong on the next. ` +
    `This step needs NO post-condition: \`step.exit()\` throws, so there is nothing after it to assert on, and when ` +
    `the condition does not hold the step is meant to leave the page exactly as it found it.`
  );
}

/**
 * Ask the model to turn one successful step into its code-behind entry
 * (stories/step-codebehind.md, "Generation").
 *
 * The model returns `{"entry": "<object literal>"}` — the client forces JSON
 * mode, so this is the assertion-code envelope pattern, not a fenced block.
 * It is never asked for the `section` field: scope comes from the step's
 * frame and the runner stamps it, so a model that guesses wrong cannot put an
 * entry in the wrong scope.
 */
export function buildStepCodePrompt(input: StepCodePromptInput): ChatMessage {
  const testInfoBlock = input.testInfoSection ? `${input.testInfoSection}\n\n` : '';

  const paramBlock = formatParameterBlock(input.parameters, input.envRefs ?? []);

  const actionBlock = input.actions.length === 0
    ? '(no actions recorded)'
    : `\`\`\`json\n${JSON.stringify(input.actions, null, 2)}\n\`\`\``;

  const assertionBlock = (input.assertions ?? []).length === 0
    ? ''
    : `\n\n## Assertions this step made\n${(input.assertions ?? [])
        .map(
          (a) =>
            `- condition: ${a.condition}` +
            (a.expected !== undefined ? `\n  expected: ${JSON.stringify(a.expected)}` : '') +
            (a.actual !== undefined ? `\n  actual on this run: ${JSON.stringify(a.actual)}` : '') +
            `\n  result: ${a.pass ? 'passed' : 'failed'}`,
        )
        .join('\n')}`;

  const captureBlock = (input.captures ?? []).length === 0
    ? ''
    : `\n\n## Values this step must capture\n${(input.captures ?? [])
        .map((c) => `- \`step.setVar('${c}', ...)\``)
        .join('\n')}`;

  const wholeTestBlock = (input.wholeTest ?? []).length === 0
    ? ''
    : `\n\n## The whole test\n${(input.wholeTest ?? [])
        .map((s) => {
          const marks = [
            s.isThisStep ? '← THIS STEP' : '',
            !s.isThisStep && s.inScope ? '(also being compiled)' : '',
            !s.inScope && !s.isThisStep ? '(already has code, or stays AI)' : '',
          ].filter(Boolean).join(' ');
          return `${s.index}. ${s.text}${marks ? `   ${marks}` : ''}`;
        })
        .join('\n')}`;

  const candidateBlock = input.candidateFile
    ? `\n\n## The code-behind file as it stands\nReuse its selectors and helpers where they fit; stay consistent with its style.\n\n\`\`\`ts\n${input.candidateFile}\n\`\`\``
    : '';

  const domBlock = (dom: string | undefined, url: string | undefined, when: string): string =>
    !dom && !url
      ? ''
      : `\n\n## Page ${when} the step${url ? `\nURL: ${url}` : ''}${
          dom ? `\n\n\`\`\`html\n${dom}\n\`\`\`` : ''
        }`;

  // The selector rules key off the measurement when there is one and stay
  // today's inference when there is not, so a transcript with no `targeting`
  // builds byte-for-byte the prompt it built before the measurement existed.
  const selectorRules =
    (measuredSelectorRules(input.actions) ?? SELECTOR_RULE_INFERRED) +
    placeholderSelectorRule(input.actions);
  // The post-condition rule follows whatever the selector rules ended on —
  // one numbered rule when nothing was measured or nothing resolved, two when
  // the `resolvedBy` rule is in play.
  const numbered = [...selectorRules.matchAll(/^(\d+)\. /gm)];
  const postConditionNumber = Number(numbered[numbered.length - 1]?.[1] ?? 8) + 1;

  // Does this step CLAIM the `If … then return` form? The same textual test
  // every runner applies to the authored line (stories/step-flow-control.md,
  // decision 2), on the same text — `rawStepText` is the step as authored.
  const claimsFlowControl = parseFlowControlStep(input.rawStepText) !== null;

  // The one re-ask the static backstop buys. The refused entry goes back with
  // the complaint, because a model shown only "do it again" tends to return
  // what it returned.
  const retryBlock = input.retry
    ? `\n\n## Your previous answer was refused\n${input.retry.complaint}\n\nThat answer was:\n\n\`\`\`ts\n${input.retry.previousEntry}\n\`\`\`\n\nFix exactly that, keep the rest of the entry, and return it in the same envelope.`
    : '';

  const textContent = `${testInfoBlock}A natural-language test step just passed under AI control. Write the Playwright TypeScript that reproduces it deterministically, so future runs need no model call.

## The step, exactly as authored
${input.rawStepText}
${wholeTestBlock}

## Parameters in scope
${paramBlock}

## The actions the AI performed (this run's transcript)
${targetingLegend(input.actions)}${actionBlock}${assertionBlock}${captureBlock}${domBlock(input.domBefore, input.urlBefore, 'before')}${domBlock(input.domAfter, input.urlAfter, 'after')}${candidateBlock}${retryBlock}

## What to return

Respond with ONLY this JSON — the code-behind entry as a single string field (standard JSON string encoding):

{
  "entry": "{ source: ..., async run({ page, step, log }) { ... } }"
}

If this step cannot be expressed as code — it needs interactive input from a person, or a judgement code cannot make — decline instead, and say why in one sentence. Opening, switching and closing tabs and browsers is NOT a reason to decline: \`tabs\` and \`browsers\` below do all six.

{
  "entry": null,
  "reason": "needs a human to read the confirmation screen"
}

The "entry" string holds one TypeScript object literal with exactly this shape:

{
  source: ${JSON.stringify(input.rawStepText)},
  async run({ page, step, log }) {
    // ...
  },
}

\`run\` receives one context object:
- \`page\`, \`context\`, \`browser\` — the live Playwright instances the run is driving.
- \`step.getVar(name)\` / \`step.setVar(name, value)\` — the test's variable scope, by the name as written in the markdown: \`{{username}}\` is \`step.getVar('username')\`. An environment placeholder is read by the name inside its braces: \`\${data.url}\` is \`step.getVar('data.url')\`, \`\${env.BASE_URL}\` is \`step.getVar('env.BASE_URL')\`. It returns a string (or undefined).
- \`step.expect(condition, message)\` — a failed expectation fails the step.
- \`step.filePath(relative)\` — turns a path written in a step (relative to the test file's folder) into the absolute path Playwright needs. Synchronous; throws if the file is missing.${claimsFlowControl ? FLOW_CONTROL_API : ''}
- \`log.info(...)\` / \`log.warn(...)\` / \`log.error(...)\` — recorded into the report.
- \`baseUrl\` — the test's configured base URL, when it has one.
- \`tabs\` — tab control, the code equivalent of the \`openPage\` / \`switchPage\` / \`closePage\` actions:
  - \`await tabs.open(url, { as })\` — open a new tab at \`url\` and make it active. \`as\` is optional and names it.
  - \`await tabs.openedBy(() => ...)\` — run the callback and adopt the tab the PAGE opened (a \`window.open\`, or a click on \`target="_blank"\`). Use this whenever the transcript is a \`click\` followed by a \`switchPage\`: the wait is armed before the click, so there is no race.
  - \`await tabs.switchTo(id)\` — make an already-open tab active. \`id\` is a label (\`'main'\`, \`'page:2'\`, or an \`as\` name), a URL substring, or a title substring — the same identifier the \`switchPage\` action in the transcript used.
  - \`await tabs.close(id)\` — close a tab. The main tab cannot be closed.
  - \`tabs.list()\` — \`{ label, url, isActive }[]\`. \`tabs.active()\` — the active page.
- \`browsers\` — browser control, the code equivalent of \`openBrowser\` / \`switchBrowser\` / \`closeBrowser\`:
  - \`await browsers.open(label, { engine, channel, headed })\` — launch an isolated browser under \`label\` and make it active. Options are all optional; without them it matches the run's own browser.
  - \`await browsers.switchTo(label)\` — make a tracked browser active. The one the test started in is \`'default'\`.
  - \`await browsers.close(label)\` — close one. Returns nothing.
  - \`browsers.list()\` — \`{ label, engine, channel, activePageUrl, isActive }[]\`. \`browsers.activeLabel()\` — the active label.

Rules — all of them are enforced:

1. **Read parameters via \`step.getVar\`, never inline them.** Write \`step.getVar('username')\`, not the value it happened to have on this run. Environment placeholders are the same rule with a different name: \`\${data.url}\` is \`step.getVar('data.url')\`, and its value is THIS environment's — the URL this run navigated to belongs to the environment, not to the step, and the same file must run against the others. Generated code containing a resolved parameter or environment value as a literal is REJECTED — this is what keeps secrets and environment-specific values out of a committed file.
2. **Compute dynamic values at runtime.** If the step describes a computation (today's date, a derived code, a formatted number), do the computation in the code. Never freeze this run's answer as a literal.
3. **Write the step's outputs** with \`step.setVar\`, using the capture name from the step text.
4. **Turn assertions into \`step.expect(condition, message)\`**, with a message that names what was compared.
5. **Rely on Playwright's web-first waiting.** Locators auto-wait; add \`locator.waitFor()\` only where the recorded run needed an explicit wait. Do NOT use \`page.waitForTimeout\` unless the recorded transcript shows a wait action that required it. Code runs far faster than AI think-time, and a missing wait is the classic generated-test flake.
6. **No imports.** Everything you need arrives via the context object — and everything you use must be in \`run\`'s destructured parameter list. The shape above shows \`{ page, step, log }\` because that is the common case, not because it is the whole context: an entry that calls \`tabs.open(...)\` must be written \`async run({ page, step, log, tabs })\`. A name you use but do not destructure is a \`ReferenceError\` on the first replay.
7. Prefer stable selectors from the transcript (ids, \`data-testid\`, roles) over positional ones.${tabHandleRule(input.actions)}
7b. **Files come through \`step.filePath\`.** An \`upload\` action's \`filePath\` / \`filePaths\` in the transcript are relative to the test file, so pass each through \`step.filePath('…')\` — the verbatim string — and give the result to Playwright. When the action's \`upload.via\` is \`"input"\`, that is \`await page.locator('#statement-file').setInputFiles(step.filePath('attachments/logo.png'))\`. When it is \`"chooser"\`, the action clicked a control that opened a picker, so write:
\`\`\`
const chooser = page.waitForEvent('filechooser');
chooser.catch(() => {});
await page.locator('#identity-choose').click();
await (await chooser).setFiles(step.filePath('attachments/statement.pdf'));
\`\`\`
(the \`.catch\` matters: without it a failing click leaves the waiter rejecting with nobody listening, which can end the run.) A parameterised path is \`step.filePath(step.getVar('name'))\`. NEVER write an absolute path, and never hand a bare string literal to \`setInputFiles\` or \`setFiles\`.
${selectorRules}
${postConditionNumber}. **End with a post-condition, and make it wait.** The last thing \`run\` does must check that the page shows the step succeeded: on replay, "did not throw" has to mean "the step worked", and without this it only means "the code ran".

   **Wait for the NEW state, then assert — never the other way round.** \`step.expect\` does not retry, and neither does a read. Code arrives a millisecond after the click that triggered the change, while the request producing it is still in flight, so \`step.expect((await el.textContent())?.includes('Uploaded logo.png'))\` compares the text the page had BEFORE the step and fails. A bare \`locator.waitFor()\` has the same hole: its default state is \`visible\`, so on an element that is already on the page it returns at once having proved nothing — and a status region reused between steps is already visible, still showing the previous message.

   Wait on the state itself. \`await page.locator('#upload-status', { hasText: 'Uploaded logo.png' }).waitFor()\` — or \`.filter({ hasText: '…' })\` on a locator you already hold — does not resolve until that text is there, so the wait IS the assertion. \`await page.waitForFunction(...)\` covers what a text filter cannot: a count that has to change, an attribute that has to flip, a value computed from the page. Reading a value into \`step.expect\` is right once something has proved the page moved — wait first, then read. (Rule 6 rules out Playwright's \`expect(locator).toHaveText(...)\`; the forms above are the waiting ones you have.)

   **And it has to be able to FAIL.** A post-condition that cannot go red proves nothing at all — it is the same as having none, only harder to notice. Never compare a value to itself, or to a variable you just assigned from the same read: \`step.expect((await rows.count()) === rowCount)\` re-reads what it has already stored, so it passes just as happily on an empty page. When the step states an expectation, assert THAT — the literal it names, the count it names. When it states none, which is the usual shape of a capture step ("Count the rows [as: n]", "Read the balance [as: b]"), assert what makes the capture worth trusting instead: that the thing you read from was really there and really populated, e.g. \`await page.locator('#documents-body > tr').first().waitFor()\` before reading the count. Never that the number equals itself.${trackerPostCondition(input.actions)}${claimsFlowControl ? flowControlRule(postConditionNumber) : ''}

Respond with ONLY the JSON object — no prose around it.`;

  return { role: 'user', content: textContent };
}
