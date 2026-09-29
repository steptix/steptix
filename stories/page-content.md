# Page content — hand back the page, let the caller read it

> **Verification rule for this story.** "Done" means: (1) `GET
> /sessions/:id/content` on a live session returns the active page's visible
> text, with its `url` and `title`; (2) `?format=dom` returns the same cleaned
> DOM snapshot the runner's AI sees, honouring the **project's** dom-cleaner
> config rather than the server's startup config; (3) `?selector=` narrows both
> formats to a subtree, and a selector that matches nothing is an error, not an
> empty string; (4) an oversized page comes back truncated with `truncated:
> true` and a char count, never silently clipped; (5) a capture that fails
> because the page was navigating is an error, not empty content; (6)
> `get_page_content` exposes all of this over MCP and refuses a session this
> MCP server did not create unless `allow_foreign_session` is set. No model is
> called anywhere on this path.

## Context

An agent host (e.g. Claude Code) can drive a browser through `run_steps`, and
can see *that* a step passed, but it cannot read the page. What it gets back
today is a fold of run events plus, optionally, a screenshot.

The machinery to answer "what does this page say" already exists and is already
on the hot path of every AI step:

| Helper | Location | Gives |
|---|---|---|
| `captureDomSnapshot(page, opts)` | [dom-cleaner.ts:186](../src/browser/dom-cleaner.ts) | Cleaned `<body>` tree — scripts/styles/comments stripped, hidden and `aria-hidden` subtrees dropped, iframes inlined over CDP, char-capped |
| `expandDomSubtree(page, selector)` | [dom-cleaner.ts:448](../src/browser/dom-cleaner.ts) | The same treatment for one subtree |
| `evaluateWithTimeout` | [dom-cleaner.ts:75](../src/browser/dom-cleaner.ts) | A `page.evaluate` that cannot hang the caller |

And `getSession` ([session-manager.ts:1123](../src/server/session-manager.ts))
already resolves the active page and returns `currentUrl`, `pageTitle`,
`screenshot` and `outputs`. Content is the one hole in a method that otherwise
describes the page.

So this is plumbing, not a new capability: one `SessionManager` method, one
route, one MCP tool.

## Locked decisions

- **No AI-side extraction. The endpoint returns the page and stops there.**
  The tempting version takes a prompt or a JSON schema and returns structured
  data. It is rejected: the MCP client *is* a model. Distilling server-side
  pays for the page twice — once to summarise it, once to read the summary —
  and throws away the caller's ability to go back for the part the distillation
  dropped. Whoever called this does the understanding. It also keeps the whole
  path free of `AI_API_KEY`, so reading a page cannot fail for want of a model,
  cannot be slow for want of a model, and costs nothing.

- **`GET`, not `POST`.** This is a read with no body and no side effect. Every
  parameter is a scalar that fits a query string, and the shape stays greppable
  in a server log.

- **Two formats: `text` and `dom`.** `text` is the visible `innerText` and is
  the default — it is what "what does the page say" means, and it is roughly an
  order of magnitude smaller than the markup. `dom` is the existing cleaned
  snapshot, for when the question is "what do I target". Markdown is not
  offered: nothing in the repo produces it today, so it is new code with no
  caller asking for it.

- **The active page only.** `pageTracker.getActive()`, same as `getSession`.
  Tab targeting is a real thing to want and a separate decision; adding a
  `tab` parameter here would duplicate an addressing scheme the CDP tools
  already have their own opinion about.

- **A failed capture is an error, never empty content.** `getSession` swallows
  page failures into empty strings (`session-manager.ts:1141`) — defensible for
  a screenshot thumbnail, wrong here. "The page has no text" and "we could not
  read the page" are different answers, and an agent that cannot tell them
  apart will confidently report the first. Same rule for a `selector` that
  matches nothing.

- **Truncation is reported, not silent.** A caller that receives 20 000 chars
  of a 400 000-char page and is not told will reason about a third of a
  document as though it were the whole one. `truncated` and the char counts are
  what make `selector` actionable rather than guesswork.

- **The read does not queue behind a running step.** `queueTail` serialises
  step execution per session, but a `GET` that blocks for the minutes a run can
  take is not a `GET`. It reads out of band — the same choice `getSession`
  already makes — and reports the session's `status` so a caller that got
  `executing` knows the page may move under it.

- **The project's browser settings are retained on the session** — *added
  during implementation.* §2 requires the project bundle's dom-cleaner options,
  but `resolveProjectBundle` is keyed on a **test file path**, and a content
  read has only a session id. The alternatives were to take `projectRoot` as a
  query parameter — which every client would then have to know for a read, and
  which could disagree with the project the session actually ran under — or to
  re-resolve from nothing, which is not possible. So `ManagedSession` keeps the
  `browser` slice of the bundle its last batch resolved, seeded from the
  server's startup config so a created-but-never-run session is still readable.
  The semantic is the defensible one: *read this page the way this session's
  own steps read pages.*

- **A selector that matches nothing is 400, not 404** — *added during
  implementation.* The session was found; the request named an element that
  is not there. 404 would say the session is missing, which is the one thing a
  caller must not be told wrongly, since it is also the signal to create a new
  one.

- **Foreign sessions are gated exactly like `close_session`.** This is the
  decision most worth being explicit about: page content is *more* sensitive
  than the ids and counts the other read-only tools hand out. A session the
  developer opened in Steptix may be driving a CDP browser holding real
  logins, and its active tab may be their bank. The repo already withholds
  foreign CDP tab *titles and URLs* by default; handing an agent the full text
  of that page unprompted would undo that policy through a side door.

## Design

### 1. Route

```
GET /sessions/:id/content?format=text|dom&selector=<css>&max_chars=<n>
```

Registered beside `GET /sessions/:id` in
[api-server.ts](../src/server/api-server.ts), behind the auth middleware — so
it bumps the idle monitor, which is correct: this is a client action, not a
poll. (The comment on the CDP block below it is the standing warning about adding
a *polled* route behind auth; this is not one.)

Response body:

```jsonc
{
  "sessionId": "mcp:abc",
  "url": "https://…",
  "title": "…",
  "status": "active",        // or "executing" — the page may be mid-flight
  "format": "text",
  "selector": null,          // echoed back so the caller sees what it read
  "content": "…",
  "truncated": false,
  "returnedChars": 8123,
  "availableChars": 8123
}
```

Validation, all before touching the page:

- Unknown `format` → **400**, naming the two that exist. It must not fall back
  to `text`: an agent that asked for `html` and silently got prose will not
  notice.
- Non-numeric or non-positive `max_chars` → **400**.
- Unknown or closed session → **404**, matching `GET /sessions/:id`.

### 2. Formats

**`text`** — a new `captureVisibleText(page, selector?)` in
[dom-cleaner.ts](../src/browser/dom-cleaner.ts), which is where page-content
extraction and `evaluateWithTimeout` already live. `innerText` of `<body>`, or
of the selector's first match. `innerText` rather than `textContent`
deliberately: it respects CSS visibility and collapses whitespace the way the
user sees it, where `textContent` would hand back the contents of
`display: none` subtrees the DOM path is careful to drop.

> **The two formats disagree about `aria-hidden`** — *measured in live
> testing, and deliberately not reconciled.* `text` includes an
> `aria-hidden="true"` subtree; `dom` drops it. Neither is wrong:
> `aria-hidden` hides an element from assistive technology while leaving it on
> screen, so `innerText` is right to report it for "what does a person see",
> and `captureDomSnapshot` is right to drop it as noise for "what should a
> model reason about". Reconciling would mean reimplementing `innerText`'s
> layout semantics by hand and making `text` lie about the screen. It is a
> documented difference, covered by a test that asserts both behaviours at
> once, and it belongs in W3's tool description.

**`dom`** — `captureDomSnapshot(page, opts)`, or `expandDomSubtree(page,
selector)` when a selector is given.

`opts` comes from `config.browser.*`, spread exactly as
[step-executor.ts](../src/runner/step-executor.ts) builds it, so a read sees
what a step sees. **This must be the per-project bundle, not the server's
startup config.** Options like `collapseRepetitiveDom` and
`domSnapshotCharLimit` are project settings; a session created for project A
must be read with project A's cleaner settings. This is a known trap in this
repo — new config consumed at request time reads `this.config` and silently
ignores the project's value.

The mechanism is `ManagedSession.browserConfig` (locked decision above), not a
re-resolution: the bundle cache is keyed on a test file path that a content
read does not have.

### 3. Size

`max_chars` defaults to **20 000**. The internal default is 100 000
(`DEFAULT_DOM_SNAPSHOT_CHAR_LIMIT`), which is right for a snapshot going into a
runner prompt and wrong for a tool result landing in an agent host's context —
100 000 chars is roughly 25 000 tokens off the caller's budget for one call.

Capture happens at the project's configured limit and is then truncated to
`max_chars`, so `availableChars` reports what capture actually produced.

> `availableChars` is a floor, not the page's true size: for `format=dom` it is
> itself bounded by the project's `domSnapshotCharLimit`. Worth stating in the
> field's description — a caller that treats it as "how much I'm missing" would
> underestimate on a very large page.

### 4. Reads during a run

The read is out of band (locked decision above), which leaves one real failure:
capture racing a navigation, where Playwright throws *execution context was
destroyed*. `captureDomSnapshot` currently absorbs its own timeout into an
`<error>…</error>` string — that string must not be returned as content.

One retry after a short settle, then **409** naming the condition and telling
the caller to retry. `status: "executing"` in the body is the advance warning;
the 409 is what happens when the warning came true.

Detecting the race is W1's job, not the route's: `PageCaptureError.kind ===
'navigated'` is set next to the `evaluate` that lost its context, where the
Playwright error text is in hand. The route maps that one kind to 409 and every
other kind to 500, rather than pattern-matching error strings a layer away from
where they were thrown.

### 5. Ownership

`checkSessionOwnership(session_id, allow_foreign_session)`
([tools.ts](../src/mcp/tools.ts)) is applied in the MCP tool handler — the same
layer `close_session` gates at. The Sessions API server does not gate: it serves
Steptix and flick too, and cannot tell an agent from a human. Not asking is
the withholding, exactly as with `includeForeignTabs`.

The helper gains an optional **consequence** clause — *added during
implementation.* Its fixed text was "running steps in it would drive their
browser", which is the wrong warning for a read: the hazard here is disclosure,
not control, and an agent told the wrong risk cannot weigh the right one. The
read passes "reading its page would disclose whatever they are signed in to";
existing callers keep the original wording by default. The gate runs before the
request goes out, so a refused read never reaches the wire.

### 6. MCP tool

```
get_page_content(session_id, project_root, format?, selector?, max_chars?,
                 allow_foreign_session?)
```

Description, which is the only text in front of the model at call time:

> Read the current page of a session: its visible text, or its cleaned DOM.
> Returns the page as-is — nothing is summarised or interpreted for you.
> `format: "text"` (default) for what the page says; `format: "dom"` when you
> need element structure to pick a selector. Narrow with `selector` rather than
> raising `max_chars` — a truncated result tells you it was truncated.

Output fields mirror §1. Every field is `.nullable()`, never optional: a
missing key fails `structuredContent` validation and degrades the whole result
to `isError` with nothing readable in it.

## Out of scope

- AI-side or schema-driven extraction (rejected above).

- **A `find` format.** `findInDom` ([dom-cleaner.ts:425](../src/browser/dom-cleaner.ts))
  already returns up to 50 leaf-like text matches, each with a *stable*
  selector, and would be the natural answer to "how do I narrow a large page
  without reading it all". Deferred, not rejected — with `text` on the table
  the gap is cost, not capability: the caller is a model and can do its own
  matching over the text it already has. The saving is modest against `text`
  (~2k tokens vs ~5–15k) and only becomes large against `dom` (~25k at the
  100 000-char cap), which means it earns its surface area on *selector
  hunting against big pages* and nowhere else. Real usage will show whether
  callers hit that; shipping it now would buy the following three problems for
  a case that may not exist:

  - **The matcher is a case-insensitive substring over `textContent`**, with no
    whitespace normalisation. `<span>Download</span><span>invoice</span>` does
    not match `"Download invoice"` (the `textContent` carries the source
    newline), and `<td>Invoice</td><td>#2024-10</td>` concatenates with no
    space. Phrase queries — the kind a model reaches for first — are the
    unreliable ones.
  - **Attributes are not searched.** An empty `<input placeholder="Search
    invoices">` never matches `"invoices"`, nor do `aria-label`, `alt` or
    `value`. On a page of empty form fields the mode returns nothing and the
    caller concludes the field is absent.
  - **The walker does no visibility filtering** — it skips
    `script`/`style`/`svg`/`meta` and nothing else. So it can return selectors
    pointing into a closed dropdown or an unopened modal — content that
    `display: none` keeps out of **both** shipped formats. Fixing that means
    changing a script the runner's own `find` exploration action depends on —
    out of this story's scope, and the reason `find` is a follow-on rather than
    a third value here.

  Two further preconditions for whenever it does land: `findInDom` calls
  `page.evaluate` directly rather than `evaluateWithTimeout`
  ([dom-cleaner.ts:438](../src/browser/dom-cleaner.ts)), so a pathological page
  can hang an HTTP request that has no step budget around it; and an empty
  query matches every element (`"".includes("")`), so the schema must reject
  one.

- A `markdown` format.
- Targeting a tab other than the active one.
- `offset`/paging through a large page — `selector` is v1's narrowing tool.
- Waiting for the page to settle before reading. The caller decides when to
  read; `waitForPageStability` belongs to steps.
- Screenshots — `GET /sessions/:id` already carries one.
- Any change to how the runner captures DOM for its own prompts.

## Composition

| File | Change |
|---|---|
| [src/browser/dom-cleaner.ts](../src/browser/dom-cleaner.ts) | `captureVisibleText(page, {selector?})`, which throws; `PageCaptureError` with a `kind` of `timeout` / `selector-miss` / `navigated` / `evaluate-failed`; `domCaptureFailure(content)` to turn the runner's in-band failure strings back into throws **without** changing what the runner sees. |
| [src/server/session-manager.ts](../src/server/session-manager.ts) | `getPageContent(sessionId, opts)` + private `capturePage` — resolve active page, dispatch on format, single navigation retry, truncate, report status. `ManagedSession.browserConfig` retains the project bundle's `browser` slice; assigned where the batch resolves its bundle. |
| [src/server/api-server.ts](../src/server/api-server.ts) | `GET /sessions/:id/content`, query validation, `DEFAULT_CONTENT_MAX_CHARS`, and the 400/404/409/500 mapping. |
| [src/mcp/types.ts](../src/mcp/types.ts) | `PageContent`; `ApiClient.getPageContent`. |
| [src/mcp/api-client.ts](../src/mcp/api-client.ts) | The fetch — query built with `URLSearchParams`, id via `encodeURIComponent`. |
| [src/mcp/schemas.ts](../src/mcp/schemas.ts) | `getPageContentInput` / `getPageContentOutput`. |
| [src/mcp/tools.ts](../src/mcp/tools.ts) | Register `get_page_content`; ownership gate; description. |

## Tests

### Unit / seam (vitest)

[tests/page-content-capture.test.ts](../tests/page-content-capture.test.ts) —
a new file rather than an addition to
[tests/dom-cleaner.test.ts](../tests/dom-cleaner.test.ts), which is
deliberately browser-free (it tests `cleanHtmlString`, the regex path that
exists precisely for "no real browser available"). Half of W1's behaviour *is*
a browser behaviour, so it launches Chromium and would change that file's
character:

- `captureVisibleText` returns visible text and omits both `display: none` and
  `hidden` subtrees — the case that fails if `textContent` is ever substituted
  for `innerText`.
- `<script>`/`<style>` bodies are excluded.
- Selector hit returns just that subtree; selector miss **raises**, while a
  matched-but-empty element returns `''` — the two must not collapse.
- A quoted selector does not break the injected script; a malformed one raises
  `evaluate-failed` rather than reading as no content.
- `domCaptureFailure` recognises all three in-band failure strings and returns
  null for ordinary content — including one test that runs `captureDomSnapshot`
  with a failing evaluate and feeds its real output back in, so the emitting
  and matching sites cannot drift apart silently.

[tests/api-server-content.test.ts](../tests/api-server-content.test.ts) — a
new file rather than additions to `api-server.test.ts` and
`session-manager.test.ts`, for two reasons: the route and the session method
are one behaviour and splitting the assertions across two files would test the
seam twice and the behaviour once; and these tests need `dom-cleaner` partially
mocked, which the shared `api-server.test.ts` mock set does not do. Driven
through the real HTTP route throughout — the client seam, not the resolver.

- 200 shape for both formats, `url`/`title`/`selector` echoed; `selector` with
  `format=dom` routes to `expandDomSubtree`, not `captureDomSnapshot`.
- Truncation: over-limit sets `truncated` with `returnedChars === max_chars`;
  content exactly at the limit does not (off-by-one); the 20 000 default
  applies when `max_chars` is absent.
- Unknown `format` → 400 naming both valid values (**not** a silent default),
  and no capture is attempted. Bad `max_chars` → 400 across `0`/`-5`/`abc`/`1.5`.
- Unknown session → 404; closed session → 404.
- Selector miss → 400 rather than an empty string.
- Navigation race → retried once, then 409; a retry that wins returns 200; a
  **timeout is not retried** (asserting the call count, since retrying a wedged
  page only doubles the wait).
- An in-band `<error>DOM capture…` string is an error, never `content`.
- **The project-config guard**: a session whose batch ran against a temp
  project with `browser.domSnapshotCharLimit: 4242` reads with 4242, not with
  the server's 999 — and a session with no project root falls back to the
  server's. This runs through the real bundle-resolution path, so it fails if
  the retention in `executeStepsInternal` is ever dropped.

[tests/mcp-seam.test.ts](../tests/mcp-seam.test.ts) — driven through a real MCP
client over a real transport, so the SDK's own output-schema validation is in
the loop:

- `get_page_content` maps every field through as `structuredContent`.
- `format`/`selector`/`max_chars` reach the wire; **nothing** is sent that the
  caller did not supply, so the server stays the single owner of the defaults.
- A truncated read reports `truncated` in structured content *and* names the
  counts and `selector` in the text summary — a content-only host would
  otherwise have to infer truncation from the serialized result rather than
  be told.
- A non-`mcp:` session is refused, the message names `allow_foreign_session`
  and what would be disclosed, and **no request is made**; with the flag it
  proceeds.
- A server 404 becomes a readable tool error, not a stack trace.
- `status: 'executing'` survives to the caller.

[tests/mcp-api-client.test.ts](../tests/mcp-api-client.test.ts):

- Query construction against a real HTTP server: session id and selector are
  encoded (a selector routinely carries `>`, `"`, `#`, `&`, and an unencoded
  `#` would truncate the URL at the fragment); no query string at all when
  nothing was asked for; a 409 surfaces the server's own message.

Three existing inventory guards also had to be updated — the tool list in
`mcp-seam.test.ts` and both manifests in `mcp-schema-dialect.test.ts`. That is
those tests working: a new tool or schema cannot be added without being
declared, so nothing ships unchecked for dialect neutrality.

### Live (manual)

**Run after W2, against a real Chromium and a local fixture page** carrying
`display:none`, `hidden`, `aria-hidden`, a hidden CSRF input, inline
`<script>`/`<style>`, and 60 000 chars of filler. Findings:

| Check | Result |
|---|---|
| `format=text` (default) | Visible text, `url` + `title` correct |
| Truncation | `availableChars: 60365`, `returnedChars: 20000`, `truncated: true` — the default applied without being asked for |
| `format=dom&selector=#invoice-list` | Clean subtree, `data-testid` selector comments intact |
| `selector=#content` on text | Nav noise and filler both gone |
| Selector miss / bad format / bad `max_chars` | 400, each naming the offending value |
| Unknown session | 404 |
| `display:none`, `hidden`, CSRF input, script, style | Absent from **both** formats |
| `aria-hidden` | Present in `text`, absent in `dom` — see §2 |

Two things worth recording beyond the table:

- **Start the server on a spare port.** A server was already listening on 3100
  from an earlier session; `serve` found it healthy and exited 0, so the live
  test would otherwise have run against a build that predated the change while
  looking like it had started fine. Check `/health`'s `pid` against the process
  actually holding the port before trusting a live result.
- **The AI was broken throughout and the endpoint did not care.** The seeding
  step failed with `401 Missing Authentication header` from the AI gateway, and
  every content read still succeeded. That is the "no model on this path"
  decision demonstrated rather than asserted: a page read does not depend on
  `AI_API_KEY` being valid.

## Found in adversarial review

Three independent reviewers ran against the finished branch. Every claim below
was reproduced by execution before being fixed; the ones that turned out to be
wrong are not listed.

**Four defects that would have shipped:**

1. **`innerText` leaked hidden text through a selector.** Per the HTML spec the
   getter returns `textContent` when the element "is not being rendered", so
   `selector: '#hidden-modal'` on a `display:none` subtree returned its full
   text — labelled visible, and unspaced (`"SSN 123-45-6789nested"`), which is
   the tell. The whole-page read was always correct; only the narrowed one
   leaked, which is why every existing test missed it. Now guarded with
   `checkVisibility()` and a `not-rendered` failure kind. `checkVisibility()`
   rather than `getClientRects()`: an empty *rendered* inline element has no
   boxes and a rects check would call it hidden.
2. **A clipped snapshot reported as complete.** `captureDomSnapshot` enforces
   the project's `domSnapshotCharLimit` before this layer sees the string, so
   `truncated` — computed from `max_chars` alone — said `false` on a page that
   had already lost three quarters of its content. Worst on the path the tool
   description actively invites: an agent that sees `truncated: true` and
   raises `max_chars` above the project limit flips a correct warning into a
   confident all-clear. `capturePage` now returns a clip flag that ORs into
   `truncated`.
3. **The browser-side failure marker was never matched.** `capture-dom.js` has
   its own try/catch emitting `<error>Failed to capture DOM: …`, a different
   prefix from the Node-side `<error>DOM capture`. `domCaptureFailure` matched
   only the latter, so a page whose DOM walk threw came back as **200 with the
   error string as its content** — precisely the confusion §4 exists to
   prevent. Now matched on the shared `<error>` envelope, which also closes the
   door on a fourth marker appearing later.
4. **`expandDomSubtree` had no evaluate budget.** It called `page.evaluate`
   bare — survivable when its only caller was a step with a deadline around it,
   but this story made it reachable from an HTTP GET, where a wedged JS thread
   would hold the request open forever. This is the same hazard the story
   already wrote down as a precondition for the deferred `find` mode; it
   shipped in the format that had it too. Now bounded like its siblings.

**Also fixed:** every non-navigation capture failure was reported as a
`timeout` (telling a caller to wait when it should narrow); an invalid selector
answered 500 rather than 400 — `div:has-text(…)` is a Playwright idiom agents
reach for constantly, and a caller-input error wearing a server-fault status is
the one class agents are trained to ignore; a repeated `?selector=a&selector=b`
silently widened the read to the whole page; a throw from `injectFrameContent`
escaped unclassified, bypassing the navigation retry; truncation could split a
surrogate pair; the `availableChars` caveat lived in a JSDoc comment that Zod
does not reflect, so it never reached the model; and `get_page_content` was
missing from three inventories (`usage.ts`, the README table, and
`server-start.ts`'s no-auto-start list).

**One test gap, proved by mutation.** Deleting the `domCaptureFailure` check on
the `dom`+`selector` branch left 63/63 green while the route returned
`[expand] No element found…` to the agent as page content. The route-level
tests only ever drove the *text* and *no-selector dom* paths. Both branches are
now covered, and the fix was verified the same way it was found — mutate, watch
three tests fail, restore.

**One documentation claim was simply false.** `capturePage` claimed to mirror
step-executor "so a read sees what a step sees". It does not: `executeStep` is
handed `this.config` (the server's startup config), while the read uses the
project's. The read side is the correct one, and bringing the runner into line
means threading `projectConfig` into `executeStep` — a separate change with its
own blast radius. The comment now says what is true and names the gap.

### Round two — attacking the fixes

The fixes were re-reviewed, and two of them were wrong.

1. **The hidden-text guard broke `display: contents`.** `checkVisibility()`
   reports false for such an element because it generates no box — but its
   children render normally and `innerText` collects them correctly (measured:
   a `display:contents` wrapper returned `"VISIBLE-ONE\n\nVISIBLE-TWO"` with a
   `display:none` child properly excluded — a real rendered read, not the
   fallback). The guard turned that working read into a 400, on an idiom that
   is everywhere: transparent flex/grid wrappers and `:host { display:
   contents }` on custom elements. **A fix that breaks working reads is worse
   than the bug it closed.** Now walks to the nearest ancestor that generates
   a box, which still refuses a `display:contents` node under a hidden parent.
   The whole-page variant also interpolated the string `"undefined"` into its
   message, since there is no selector on that path.
2. **The invalid-selector 400 never reached `format=dom`.** The expand branch
   of `domCaptureFailure` returned a hardcoded `evaluate-failed`, so it stayed
   a 500 — on the very format the tool description steers agents to for
   selector work. Routed through the shared classifier.
3. **The `<error>` envelope check was applied to the wrong path.** A snapshot
   always begins `<body`, so a leading `<error>` there can only be a failure —
   but expand output begins with whatever tag was asked for, so a page
   containing its own `<error>` element read as a capture failure, and one
   whose text contained "SyntaxError" was reported as an invalid selector for a
   perfectly valid one. `domCaptureFailure` now takes the source explicitly.
4. **`bad-selector` was inferred on requests with no selector.** The match is a
   substring (`syntaxerror`) loose enough to appear in unrelated error text, so
   a whole-page capture that failed inside the page's own code told the agent
   to fix an argument it never sent. Gated on whether a selector was involved.
5. **`expandDomSubtree`'s new timeout changed the runner's contract.** Bounding
   it was right, but throwing was not: `captureDomSnapshot` carries the same
   budget and degrades *in band*, letting the AI retry next turn, while the
   `expand` action would now abort a step that used to survive. It degrades in
   band too — same budget, same contract — and the endpoint classifies from the
   marker either way.

Also: an empty `?selector=` had the same silently-widening behaviour as the
array case; `tests/mcp-cdp-seam.test.ts`'s fake client no longer satisfied
`ApiClient` (invisible to CI, since `tsconfig` excludes `tests`); and the MCP
handler defaulted a missing `content` to `''` — reintroducing "unreadable reads
as empty" at the last layer to salvage a response that is already malformed. It
now refuses.

### Round three — no blockers

The `display: contents` walk was attacked against real Chromium across 24 tag
types, plus shadow DOM, a `display:contents` root, and a walk terminating at
`null`. No leaks, and `probe === null` proved unreachable — Chromium blockifies
`display: contents` on the root element, so the walk always terminates at
`<html>`. The other five round-2 fixes traced clean.

One asymmetry it did surface, present since the feature's first commit rather
than introduced by either fix round: `format=dom&selector=` on a hidden element
returned **200 with `content: ""`**, because `expandDomSubtree` filters
invisible elements to an empty string — while `format=text` correctly raised
`not-rendered` for the same selector. That is the empty-versus-unreadable
conflation this story exists to remove, on the format the tool description
steers agents toward for selector work. Fixed with a third expand marker.

**Accepted, not fixed:** an element that is both `display: contents` *and*
inside a `content-visibility: hidden` subtree reads as `''` rather than
refusing, because the walk escapes to an ancestor whose own `checkVisibility()`
is true. No text is disclosed (`innerText` is empty there for the whole page
too), and the remaining inconsistency is between two siblings in a skipped
subtree. Left alone deliberately: two rounds of tightening this guard produced
one regression that broke working reads, and the marginal correctness here does
not justify a third pass of clever DOM logic.

**Not fixed, deliberately.** `checkSessionOwnership` tests `startsWith('mcp:')`,
which cannot distinguish *this* MCP server from another one against the same
Sessions API server — so two MCP hosts sharing port 3100 can read each other's
sessions without the gate firing. The threat this story names (a developer's
editor, which names sessions by test file path) is correctly gated. The
residual gap is pre-existing, shared with `run_steps` and `close_session`, and
same-user/same-machine — but `get_page_content` is the first tool that makes it
a pure disclosure channel, so it is worth its own change: stamp session ids with
the MCP server's instance id and gate on that.

## Risks / open

- **`innerText` is layout-dependent and can be slow on very large pages.** It
  forces layout, unlike `textContent`. `evaluateWithTimeout` bounds it, and the
  timeout surfaces as §4's error rather than as empty content — but a
  pathological page may be reachable only via `selector`.
- **Truncation at a char boundary can cut mid-tag in `dom` format.** Accepted:
  the alternative is parsing to find a safe cut, and the consumer is a model
  reading for structure, not a parser. `truncated: true` is the disclosure.
- **The 20 000 default will be wrong for someone.** It is a default, not a cap;
  the reason it is low is that the expensive mistake (blowing a context window)
  is silent and the cheap one (asking again with a higher limit) is not.
- **Reading during a run is inherently racy.** `status` plus the 409 make it
  visible rather than safe. Making it safe means queueing, which is rejected.

# Plan

## Workstream graph

```
W1 capture helpers ──> W2 server method + route ──> W3 MCP tool
```

Strictly sequential — each layer's tests need the one below it — but each lands
independently useful: W2 alone gives Steptix and flick the endpoint.

## Workstreams

**W1 — capture helpers.** §2. `captureVisibleText`, and the failure-vs-empty
distinction in the existing capture path. Pure `dom-cleaner.ts`, no session or
HTTP concerns; testable against a fixture page.

**W2 — server method and route.** §1–§4. `getPageContent`, the route, query
validation, truncation, the navigation retry. Write the project-bundle test
first: it is the one that fails silently in production and loudly nowhere else.

**W3 — MCP tool.** §5–§6. Client method, schemas, registration, ownership gate,
description. The foreign-session refusal is the point of this workstream, not
an extra.

## Repo gotchas

- **Rebuild `dist/` and restart the Sessions API server.** The running server
  executes compiled `dist/`, and the MCP server the host (e.g. Claude Code)
  spawns runs `dist/` too — a `src/` edit is not live for either until
  `npm run build`. No Steptix extension version bump is needed: this is
  server-side, and the extensions are HTTP clients.
- **Output schemas are SDK-validated.** Every new field `.nullable()`, never
  optional — a missing key degrades the result to `isError` with no structured
  content at all.
- **The full vitest run is intermittently flaky** (worker-pool crash, all files
  at once, ~8 s, 0 tests). Re-run the single file before believing a
  regression.
- **`config.browser.*` at request time is the trap.** Per-project values must
  come off the resolved project bundle; reading `this.config` compiles, passes
  a naive unit test, and is wrong for every project but the server's own.
