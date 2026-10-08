/** All supported AI action types */
export type ActionType =
  | 'click'
  | 'type'
  | 'select'
  | 'navigate'
  // Move the ACTIVE TAB through its own session history — the browser's back
  // and forward buttons (docs/specs/SPEC-browser-history.md). Not a click on
  // anything in the page, and not reachable by a keypress: a key event is
  // delivered to the focused element, so a back shortcut silently does
  // nothing, which is the measured defect these exist to close (§2).
  | 'back'
  | 'forward'
  // The browser's reload button, on the active tab — the deferral in
  // SPEC-browser-history.md §9, taken up by Record Steps
  // (docs/specs/SPEC-record-steps.md §4): a recorded Refresh has to run.
  | 'reload'
  // Drag `selector` onto `target` (both CSS selectors, same frame). Record
  // Steps records drags, so the runtime has to perform them.
  | 'drag'
  // Decide how the NEXT browser dialog (alert, confirm, prompt) is answered
  // (docs/specs/SPEC-web-survey-fixes.md §2.1). Nothing happens on the page:
  // a dialog blocks the page until it is answered, so the answer has to be
  // set before the click that opens it, in the same turn.
  | 'dialog'
  | 'upload'
  | 'hover'
  | 'wait'
  | 'scroll'
  | 'switchFrame'
  | 'switchPage'
  | 'closePage'
  | 'openPage'
  | 'openBrowser'
  | 'switchBrowser'
  | 'closeBrowser'
  | 'dismiss'
  | 'assert'
  | 'keyboard'
  | 'keypress'
  | 'prompt'
  // API action types
  | 'api_call'
  | 'extract_csrf'
  | 'extract_value'
  // Capture a DOM value into a test variable
  | 'read'
  // Read named columns from one native <table> into one record per visible
  // data row (docs/specs/SPEC-structured-table-reads.md §6). Deterministic:
  // the model names the table and the columns, and the runtime owns header
  // mapping, row selection and alignment.
  | 'readTable'
  // Count elements matching a selector and store the result
  | 'count'
  // Search the full DOM for specific text, return matching elements with selectors
  | 'find'
  // Return the full DOM subtree for a given selector (expand collapsed content)
  | 'expand'
  // Explicit no-op: AI signals the step/instruction is already satisfied
  | 'noop'
  // End the flow this step is in, as a pass — the model's answer when an
  // `If … then return` / `… then stop` step's condition HOLDS
  // (stories/step-flow-control.md). Honoured only on a step whose text claims
  // that form; on any other step the executor refuses it and tells the model
  // why. It performs nothing on the page: it is a signal to the run loop.
  | 'return'
  // Fail the run on purpose, in the author's own words — the model's answer when
  // an `If … then fail the test with error "…"` step's condition HOLDS
  // (stories/step-failure-outcomes.md, decision 1). The sibling of `return`, gated
  // the same way: honoured only on a step whose text claims the `fail` verb,
  // refused on every other, including one claiming `return` / `stop`. Performs
  // nothing on the page.
  | 'fail';

/**
 * One column of a `readTable` action
 * (docs/specs/SPEC-structured-table-reads.md §6.1).
 *
 * A column is named EITHER by its visible header text OR by its one-based
 * position, never both and never neither — the parser rejects the action
 * outright rather than guessing, because a guessed column silently misaligns
 * every row.
 */
export interface TableReadColumn {
  /** Visible header text, matched after whitespace/case normalization.
   *  Exactly one of `header` and `index` is present. */
  header?: string;
  /** One-based column position, for a table with no header row (§4.4). */
  index?: number;
  /** Property written on every output row. Never `_row` (§4.5). */
  key: string;
  /** How the cell is read. Phase 1 accepts only 'text' (the default);
   *  phase 2 adds 'checked' | 'value' | 'attribute' (§1.3, §7.4). */
  mode?: 'text';
}

/**
 * The structure of a table the model named once, validated against the page
 * and then replayed deterministically
 * (docs/specs/SPEC-structured-table-reads.md §7.10).
 *
 * Every selector in one is CSS **relative to the mapping root** and is
 * resolved with `root.querySelector(…)`. The root is the region — the element
 * the action's own `selector` matched — except when the region is a
 * `<table>`, where it is the nearest ancestor below `<body>` holding another
 * table or grid, because §5.9.2's header table sits BESIDE the rows and
 * `querySelector` cannot reach out of its own root. `:scope` is that root,
 * which is how a table whose headings are its own first body row (§5.9.1)
 * names itself. The runtime derives these selectors from the sketch it showed
 * the model, as `#id` when the element has one and a `:scope > …`
 * `nth-of-type` path otherwise, so a page with generated class names still
 * maps.
 *
 * A wider root is not a wider licence to read: `rows` must still resolve
 * inside the region the author selected, and only `header.selector` may reach
 * a table beside it (§7.10, and `mayName` in the extractor).
 *
 *  - `table` — the ordinary extractor with the two tables pinned instead of
 *    searched for. `rows` names the table or ARIA grid holding the data;
 *    `header.selector` names the one whose header grid is used (the same
 *    element when the headings are in the rows table), and `header.bodyRow`
 *    is the one-based BODY row of it that holds the headings, spliced out of
 *    the data when it belongs to the rows table. No `header` at all is a
 *    positional read.
 *  - `collection` — repeated elements that are not a table: `item` is the
 *    element repeated once per record, and `fields` maps each requested
 *    column's `key` (never its header or its index — a collection has no
 *    headings to match and no columns to count) to a selector relative to
 *    that item.
 */
export type TableReadMapping =
  | { kind: 'table'; rows: string; header?: { selector: string; bodyRow?: number } }
  | { kind: 'collection'; item: string; fields: Record<string, string> };

/** A single action returned by the AI */
export interface AIAction {
  action: ActionType;
  /** CSS selector for the target element */
  selector?: string;
  /**
   * `drag` only: CSS selector of the element `selector` is dropped ON. Resolved
   * in the same frame as `selector`, with the same visible-first rule.
   */
  target?: string;
  /**
   * `drag` only: which side of the target to let go on, for a list that
   * decides before/after by where the pointer is (SPEC-web-survey-fixes.md
   * §2.36). Omitted means the target's centre.
   */
  position?: 'above' | 'below' | 'left' | 'right';
  /** `click` only: 2 for a double-click. Omitted means one click. */
  clickCount?: 1 | 2;
  /** `click` only: the mouse button. Omitted means left. */
  button?: 'left' | 'right' | 'middle';
  /**
   * `click` only: milliseconds to hold the button down before releasing, for
   * a press-and-hold (SPEC-web-survey-fixes.md §2.24). Omitted means an
   * ordinary click.
   */
  holdMs?: number;
  /**
   * `select` only, on a `<select multiple>`: every option to select, each
   * matched by value and then by label. A single-select ignores it.
   */
  values?: string[];
  /** `count` only: count hidden matches too. Omitted counts visible matches. */
  includeHidden?: boolean;
  /** `dialog`: the text a prompt dialog is answered with. `keyboard`: text typed
   *  into whatever has focus (SPEC-web-survey-fixes.md §2.27). */
  text?: string;
  /** Text to type, option value to select, or condition to wait for */
  value?: string;
  /** URL to navigate to */
  url?: string;
  /** File path for upload actions, relative to the test file's folder unless
   *  it is a drive-letter, UNC or `file://` path. Never absolute as the model
   *  writes it — see stories/upload-action.md, decision 2. */
  filePath?: string;
  /** Several files for ONE upload. Exactly one of `filePath` / `filePaths`;
   *  the parser drops the loser and the executor reads both through
   *  `uploadPathsOf`. */
  filePaths?: string[];
  /** Condition string for wait/assert actions */
  condition?: string;
  /** Expected value for assertion */
  expected?: string;
  /**
   * `assert` only, and only ever `false`: the model conceding, in its own
   * judgment, that the step cannot be done (system prompt rule 24; the retry
   * after an unknown action type). Nothing is evaluated — the step loop fails
   * the step with {@link evidence} and does not retry it. The parser drops
   * `"holds": true`: a model certifying its own pass is not believed.
   */
  holds?: false;
  /** With `holds: false`: why the step cannot be done, in the model's words. */
  evidence?: string;
  /** Scroll direction */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Scroll amount in pixels */
  amount?: number;
  /**
   * Absolute scroll target for "scroll" actions: "top" drives the document
   * scroller to y=0, "bottom" to its current maximum. Pointer-independent,
   * unlike `direction`/`amount`, and exact at any page height.
   * Precedence within a scroll action: `selector` > `to` > `direction`.
   * (`to` is also the key switchBrowser uses for its target label; the parser
   * normalises that one into `browserLabel`, and only scrolls read this field.)
   */
  to?: 'top' | 'bottom';
  /** Type of wait to perform */
  waitType?: 'selector' | 'hidden' | 'text' | 'url' | 'load' | 'duration' | 'count' | 'attribute' | 'navigation' | 'stable';
  /** Timeout in milliseconds for wait actions */
  timeout?: number;
  /** Keyboard key or shortcut (e.g. "Enter", "Control+a") */
  key?: string;
  /** Question to ask the user for prompt actions */
  question?: string;
  /** HTTP method for api_call actions (GET, POST, PUT, etc.) */
  method?: string;
  /**
   * Request body for api_call actions.
   * The AI provides this as a JSON-serialisable value.
   */
  body?: unknown;
  /**
   * Additional HTTP headers for api_call actions.
   * The AI includes auth headers as specified in the API context.
   */
  apiHeaders?: Record<string, string>;
  /**
   * Execution mode for api_call: 'browser' uses Playwright context.request (carries cookies),
   * 'standalone' uses native fetch. Defaults to 'standalone'.
   */
  apiMode?: 'browser' | 'standalone';
  /** CSS selector for extract_csrf actions (where to find the token) */
  source?: string;
  /** JSONPath-style path for extract_value actions (e.g. "data.0.id") */
  path?: string;
  /** Multi-purpose name field:
   *   - extract_value → variable name for the extracted value
   *   - openPage      → custom page label so subsequent switchPage calls can
   *                     target this tab by name (deterministic across re-runs;
   *                     avoids ambiguity when two tabs share a similar title) */
  as?: string;
  /**
   * For "read" actions, the DOM attribute to capture (e.g. "href", "src", "value").
   * When omitted, falls back to the element's value (for form inputs) or textContent.
   * Use this when the displayed text differs from the underlying attribute — e.g.
   * search-result links where the visible URL is a stylised breadcrumb.
   *
   * `"url"` is the one name that is not purely an attribute: with no element on
   * a page carrying its address, it reads the element's own document location,
   * which is how "capture the current page URL" is expressed. A real `url`
   * attribute still wins where one exists (prompt rule 13c).
   */
  attribute?: string;
  /**
   * For "read" actions, when true the action collects the captured value from
   * EVERY element matching `selector` and stores them as a JSON-encoded
   * string array in the variable named by `as`. When false/omitted, only
   * the first match is captured (current single-value behaviour).
   *
   * Combine with `attribute` to scrape e.g. every `href` under a section:
   *   { action: "read", selector: "section a[href]", attribute: "href",
   *     as: "links", multiple: true }
   *
   * Tool calls that declare an array-typed parameter (e.g. `urls: string[]`)
   * decode the JSON string back into a typed array at the bridge boundary,
   * so authors can pipe the captured list straight into a looping tool:
   *   `[tool: visit-each urls={{links}}]`
   */
  multiple?: boolean;
  /**
   * For "read" actions, an optional JavaScript regular expression applied to the
   * captured value to slice out a substring. The first capture group is stored
   * (or the whole match when the pattern has no group). A read with no `pattern`
   * stores the element's whole value/textContent, as before.
   *
   * Applied in Node *after* capture, so it composes with `attribute` (slice an
   * href/data-* value) and `multiple` (applied per element; non-matching
   * elements are dropped). Fail-hard (issue 020): an invalid pattern or a
   * non-match fails the step rather than silently storing "" or the whole text.
   *   { action: "read", selector: "div.account", as: "account_number",
   *     pattern: "Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" }
   */
  pattern?: string;
  /**
   * For "readTable" actions, the columns to read, in the order they appear on
   * every output record (after `_row`, which the runtime writes itself). The
   * parser validates the whole list or rejects the action — a partial
   * structured read is more dangerous than a failed step (§6.2).
   */
  columns?: TableReadColumn[];
  /**
   * readTable only: capture at most this many visible data rows after
   * visibility filtering, in DOM order. Omission means all visible rows,
   * subject to the absolute 500-row safety cap.
   *
   * It is the author's own bound ("the first 10 visible rows"), not a
   * configurable replacement for `read multiple`'s READ_MULTIPLE_MAX: with a
   * limit a table MAY hold more than 500 rows, and without one a table that
   * does fails rather than truncating (§7.5).
   */
  limit?: number;
  /**
   * readTable only: how to read a table structure alone cannot decide (§7.10).
   *
   * A field the RUNTIME owns, not the model. The parser strips it from
   * anything the model emits — a mapping the runtime never validated would
   * pin the read to whatever selectors a hallucination produced — and the
   * report shows it. It is written only after a shape refusal, one structure
   * question and a validation pass against the page; a later step of the same
   * run reading the same region applies it without asking anything
   * (src/runner/structure-memo.ts).
   */
  mapping?: TableReadMapping;
  /**
   * CSS selector identifying the <iframe> element in the main page that contains the target element.
   * When set, the action is executed inside that frame rather than the main page.
   * Omit for elements in the main page.
   */
  frame?: string;
  /**
   * Target page identifier for switchPage actions.
   * Can be a label ("main", "page:2"), a URL substring, or a title substring.
   */
  page?: string;
  /**
   * For openBrowser/switchBrowser/closeBrowser: the browser session label.
   * `as` on `openBrowser` registers the new session under this name (used by
   * subsequent `switchBrowser to=<label>`); `to` on `switchBrowser` selects
   * the target. Reserved name: `default` is the initial browser.
   */
  browserLabel?: string;
  /**
   * For openBrowser: which Playwright engine to launch. Defaults to the
   * test config's engine. Valid: 'chromium' | 'firefox' | 'webkit'.
   */
  engine?: 'chromium' | 'firefox' | 'webkit';
  /**
   * For openBrowser (chromium engine only): the Playwright channel name.
   * 'chrome' (default), 'msedge' for Microsoft Edge, 'chrome-beta', etc.
   * Ignored for firefox/webkit.
   */
  channel?: string;
  /**
   * For openBrowser: override the test config's headed/headless mode.
   * Mainly useful for debugging (e.g. open Edge headed while default runs headless).
   */
  headed?: boolean;
  /** Human-readable description of what this action does */
  description: string;
  /**
   * For "assert" actions: bounded polling on the assertion JS code. When set,
   * the framework re-evaluates the generated code in a loop until
   * `pass: true` or the timeout is hit. Used for eventual-consistency cases
   * (e.g. "the toast eventually shows Saved") where no deterministic Playwright
   * wait primitive fits. Defaults: timeoutMs 5000, intervalMs 250.
   */
  poll?: { timeoutMs?: number; intervalMs?: number };
  /**
   * For "assert" actions: which context the assertion evaluates against.
   * - `'dom'` (default): assertion JS queries `document.*` only.
   * - `'api'`: assertion is purely about prior API responses; DOM is not sent
   *   to the AI when generating code.
   * - `'both'`: both DOM and API context are available.
   * - `'predicate'`: the assertion is a self-contained predicate — everything
   *   either side of the comparison is in the step text itself, as a literal
   *   or as a `{{name}}` / `${…}` placeholder listed under `## Values`, and no
   *   DOM or API context is needed. `condition` holds the predicate AS
   *   WRITTEN, placeholders included; the framework substitutes them before
   *   the check is generated (stories/placeholder-preserving-actions.md,
   *   decision 5 — predicate `condition` is the one free-text field that is
   *   value-bearing, because a predicate compares values rather than reporting
   *   the model's reading of the page). `expected` is omitted in this mode —
   *   the parser rejects it strictly to keep modes from drifting.
   */
  against?: 'dom' | 'api' | 'both' | 'predicate';
}

/** The structured response from the AI for a test step */
export interface AIResponse {
  actions: AIAction[];
  reasoning: string;
  /**
   * When true, the AI signals it needs a fresh snapshot before planning remaining actions.
   * The executor will re-evaluate after executing the returned actions.
   */
  needs_reeval?: boolean;
  /**
   * True when the model answered with a bare action object or bare array —
   * no `actions` wrapper — and gave no boolean `needs_reeval` either. A wrapped response
   * that omits `needs_reeval` is saying "done" (system prompt rule 15); a bare
   * one has skipped the whole wrapper, so its silence says nothing about
   * whether the step is finished. The executor decides what that means.
   */
  reevalUnstated?: true;
}

/** AI response for a branched (conditional) step evaluation */
export interface BranchedAIResponse {
  /** Which outcome label matched (e.g. "A", "B") or "waiting" */
  matched: string;
  /** Actions to execute for the matched outcome (empty if "waiting") */
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;
}

/** Result of an AI assertion evaluation */
export interface AssertionEvaluation {
  pass: boolean;
  /** The actual value extracted from the page */
  actual: string;
  /** Explanation of why the assertion passed or failed */
  explanation: string;
}

/** A single content block in a multimodal message */
export type MessageContentBlock =
  | { type: 'text'; text: string; cache?: boolean }
  | { type: 'image_url'; image_url: { url: string }; cache?: boolean };

/** A message in the AI conversation */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContentBlock[];
}
