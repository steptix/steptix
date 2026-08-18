# Photographing a tab you already have open

## In plain terms

You can already say *"what's on my openrouter tab?"* and get the page back as
text — that is [peek_tab](tab-peek.md), and it changes nothing about your
browser. What you cannot say is *"show me a **picture** of it"*.

The reason is a plumbing detail no user should have to know: the only
screenshot we expose, `get_page_content` with `format: "screenshot"`, takes a
`session_id`. A session is a *run* — steps executed against a page. A tab you
opened by hand in your own signed-in Chrome has no session, so there is nothing
to name, and the agent either fails or reaches for some other tool entirely.

That happened in practice: asked to screenshot a page, an agent used a
different MCP server's screen-region grabber, because aiui had nothing to offer
for a tab it could plainly see in `list_cdp_browsers`.

This story adds no tool. It answers the question
[tab-peek](tab-peek.md) §Open questions parked — **`format: "screenshot"`** —
and settles it on `peek_tab` itself, with one companion argument, `full_page`.

### What it looks like in practice

**You say:** *"Take a screenshot of the openrouter tab"*
**You get:** the picture. Today: nothing, or another tool.

**You say:** *"What's on my dashboard tab right now?"*
**You get:** its text, as today — the picture is opt-in, because an image costs
real context and most reads do not need one.

**You say:** *"Screenshot the whole page, not just what's visible"*
**You get:** the full scrollable page (`full_page: true`).

**You say:** *"Screenshot that tab"* — of a browser this framework did not start
**You get:** the same "no tab matches" a text peek gives, for the same reason:
a peek takes no `port`, so a foreign browser cannot be addressed at all.

> **Verification rule for this story.** "Done" means: (1) a tab with **no
> session** is photographed by name alone, `peek_tab` naming it exactly as a
> text peek does; (2) the capture happens with the tab **backgrounded and the
> window minimized**, and nothing about the user's screen changes — no
> activation, no raise, no focus steal, asserted at the layer where it could
> actually fail rather than at a mock; (3) the image is a **live frame**, not a
> stale or blank one, proven against a page that changed since it was last
> visible and **read with human eyes**, not inferred from a byte count; (4)
> `full_page: true` returns the whole scrollable page, and its pixel height
> exceeds the viewport shot's; (5) a foreign browser's tab is **unreachable**,
> not gated — the peek's no-`port` construction, asserted as the same refusal a
> text peek gives; (6) an oversized image is reported as an error naming the
> cap, never silently dropped or truncated; (7) the two arguments that cannot
> be honoured for a picture — `selector` and `max_chars` — are **refused**,
> never ignored; and (8) **no call hangs**: every capture answers within a
> bounded wait, and one that does not is reported with the window named as the
> likely cause.
>
> Items (2) and (3) are why the live proof is not optional here. Both passed
> against a mock and against a *freshly staged* tab while being false in
> general — see W2 — and only running them against a real minimized window with
> a page that had changed underneath it caught that.

## What was measured, so nobody re-derives it

Read this section before changing anything in the capture. It contains one
finding that **overturned this story's first draft**, and the draft was wrong
in the optimistic direction — which is the direction that ships.

**W0**, against real headed Chrome (150.x) on Windows, capturing openrouter.ai
in a 1689×1277 viewport, driving CDP by hand:

| Case | Result |
| --- | --- |
| Background tab (another tab frontmost), default params | 218.2 KB, live frame |
| Same, `fromSurface: false` | 26.7 KB — **12% the size, degraded**. Do not use |
| Same, `captureBeyondViewport: true` | 545.3 KB at 1674×**3361** — full scrollable page |
| **Window MINIMIZED**, default params | 217.9 KB, a fresh frame |

That last row is what this story was written on: *"the occlusion worry does not
happen here."* **It was a single lucky sample.** W2 below reproduces it
alongside its opposite, from the same call.

**W1**, read out of the pinned `playwright-core` 1.59.1: `CRPage.takeScreenshot`
sends `Page.getLayoutMetrics` then `Page.captureScreenshot` with no
`fromSurface` (so the good default holds) and `captureBeyondViewport:
!fitsViewport`. **Nothing in the screenshot path calls `Page.bringToFront`** —
it appears only as the explicit `page.bringToFront()` API, whose callers are the
recorder and `launchApp`. The no-raise promise therefore survives the Playwright
layer rather than being asserted about it.

**W2** is the one that matters, and it came out of running the live proof rather
than reasoning about the protocol. Capturing a background tab, then the same tab
with its window minimized:

| Window | Call | Result |
| --- | --- | --- |
| minimized | `Page.captureScreenshot`, no extra params | **hung, 20s+** |
| minimized | `captureBeyondViewport: false` | OK, 1.1s |
| minimized | `captureBeyondViewport: true` | **hung, 20s+** |
| minimized | no params again, seconds later | OK, 0.2s |
| minimized | Playwright `page.screenshot()` (viewport) | **hangs → TimeoutError** |
| minimized | Playwright `page.screenshot({fullPage:true})` | OK |

The same call both hangs and succeeds, so this is **not** about parameters. A
tab that is not frontmost composes no new frame, and the capture blocks waiting
for one; sometimes something wakes it, sometimes nothing does.
`Page.getLayoutMetrics` stays perfectly healthy throughout (it reports the real
1689×1277), which is why it reads as a hang rather than an error. Two further
facts fell out of the same run:

- **A hung capture poisons the tab.** Chromium serializes captures per target,
  so the next request queues behind the stuck one — observed as a *viewport*
  request answered with a *full-page* image, minutes later.
- **`page.viewportSize()` is null for a CDP-attached page**, so the run
  pipeline's helper reports `DEFAULT_BROWSER_DIMENSIONS` — 1440×900 — as the
  size of an image that is nothing of the sort. That reached a live result
  before it was caught.

**W3 is the fix, and it makes the original promise true after all.** Running a
1×1 `Page.startScreencast` around the capture asks the renderer for frames —
exactly what a hidden tab has stopped producing:

| Scenario | Plain capture | With the screencast |
| --- | --- | --- |
| background tab, page just changed | fresh, 0.6s | fresh, 0.2s |
| **minimized**, unchanged | **hung, 12s+** | OK, 0.2s |
| **minimized**, page changed | **hung, 12s+** | **fresh, 0.2s** |
| minimized, full page | **hung, 12s+** | OK, 0.3s |

No staleness in any cell, no hang in any cell, and the frames are discarded. It
costs one extra protocol call and changes nothing the user sees — unlike
`Page.bringToFront`, which would photograph their tab by yanking it in front of
them.

Consequences, and they are the whole design:

- **We never activate the tab.** Measured as unnecessary (W3), and unreached
  through Playwright (W1).
- **`fromSurface: false` is a trap** — the one variant that degrades. Nothing
  exposes the knob.
- **The peek does NOT use the run pipeline's `captureScreenshot`.** Playwright's
  viewport path times out on exactly these windows, and its dimensions are
  fabricated for a CDP page. `captureTabScreenshot` drives the protocol
  directly, reads width and height out of the PNG's own IHDR header, and bounds
  its wait so a stuck capture is reported rather than inflicted.

## The surface

```
peek_tab {
  tab: "targetId:A9C520997183361C34496DB4DD6DEB53",   // or title~openrouter
  format: "screenshot",        // alongside "text" (default) and "dom"
  full_page: false,            // default: the viewport
  profile: "default",          // plus engine/scope, exactly as today
  scope: "user"
}
```

Addressing, ownership, project resolution and every refusal are **`peek_tab`'s,
unchanged** — `resolveCdpTarget` for profile/engine/scope, `matchTabsByName`
over the page-type-filtered listing so an `iframe` or `browser_ui` id can never
be photographed, the zero/several candidate refusals, the synthetic
`.aiui-peek.md` that resolves the project, the `activate: false` attach, the
disconnect-not-kill detach, and the JSON-envelope-versus-bare 404 split.

The result carries the image the way `get_page_content` already does — an image
block plus a text summary naming the tab — so hosts that render only one half
still get something useful.

### Why this is not `screenshot_cdp_tab`

An earlier draft of this story proposed a separate verb taking `target_id` plus
`profile`/`port`, modelled on `focus_cdp_tab`. That draft predates `peek_tab`
shipping, and it is wrong now for the reason it stated about itself: *a fourth
spelling of "which browser did you mean" is how two verbs start disagreeing
about what a caller may touch.*

Three things settle it. [tab-peek](tab-peek.md) §Open questions already parks
this exact feature as **its own** question, deferred only for "the return-size
and privacy questions" — which is precisely what §Locked below decides.
[tab-peek](tab-peek.md) §Routing sells three doors, one question each; "read a
tab's text here, read its picture there" splits one question across two doors,
which is the thing that routing section exists to prevent. And the separate
verb would have needed a `port` argument to be addressable at all, re-opening
the foreign-browser gate that the peek closes *by construction*.

The draft's "no fuzzy matching" lock is dropped with it, and deliberately: the
peek's name-matching refuses zero and several matches with the candidates
listed, which is the safety property that lock was reaching for. It is a
**named amendment to this story's own earlier draft**, recorded here rather
than deleted, so the next reader knows the question was asked.

## Locked decisions

- **Capture in place; never activate.** Measured as unnecessary (W3), and
  verified as unreached through Playwright (W1). Activating would make a read
  verb move a window on someone's screen. If a future platform *does* need it,
  it must be an explicit argument a caller opts into, never a silent side
  effect of asking for a picture.

- **Wake the renderer, never the window.** The screencast (W3) is the whole
  difference between a promise and a coin flip, and it is invisible: 1×1 frames,
  discarded, stopped before the detach. Anything that reaches for
  `Page.bringToFront` instead has traded the user's screen for the same picture.

- **The wait is bounded, and a timeout says which thing failed.** W3 should mean
  it never fires; it stays because a capture that hangs does not merely fail
  slowly — it poisons the tab for the next request (W2). A timeout is a fact
  about the WINDOW, and reporting it as a generic failure would send someone
  debugging their page instead of restoring their browser.

- **Ownership is settled by construction, not by a gate.** `peek_tab` takes no
  `port`, so only a profile-resolved — therefore registry-owned — browser can
  be addressed, and mcp-cdp-browser §6's foreign-port gate is unreachable from
  here. A photograph discloses strictly more than a title, so inheriting the
  *stronger* posture is the right way round. This is the earlier draft's
  `allowUnowned` rule replaced, not relaxed.

- **Surface capture only.** `fromSurface: false` is measurably degraded and is
  not exposed, so no caller can select the broken variant.

- **The existing size cap applies, and an oversized image is an error.**
  Reusing `MAX_SCREENSHOT_BASE64`, and reusing `get_page_content`'s rule that
  an over-cap image fails loudly — there is nothing else in the response worth
  having once the picture is gone. `full_page: true` on a long page is the
  realistic way to hit it, so the error says so and names `full_page: false`
  as the fix.

- **A failed capture is an error, never an empty picture.** The capture answers
  a reason rather than throwing — a missing image must not fail a passing run in
  the pipeline it was borrowed from, and here the image *is* the answer. The
  peek route turns that into a refusal saying what `get_page_content`'s does:
  this is not a blank page.

- **`selector` and `max_chars` are refused, not ignored.** Both are text
  concepts. Silently dropping `selector` would answer a request for one element
  with a picture of the whole page — a wrong answer wearing a right one's
  clothes, which is the exact trap the peek route's own `?selector=` handling
  already 400s on. `max_chars` cannot bound an image at all; the cap that
  governs is the size cap, and the refusal says which.

- **The picture is opt-in and per-call.** `format: "screenshot"` is never a
  default and is not retained the way run settings are. An image costs real
  context and is a photograph of a live signed-in browser.

## Not in this story

- **Navigating a tab by name.** The other half of *"open openrouter and take a
  screenshot"*: with no session, pointing an existing tab at a URL is
  `run_errand`'s job today. That is a *write* to someone's live tab where this
  is a read, and [tab-peek](tab-peek.md) §Routing already routes it.

- **Element screenshots.** `selector` is refused rather than implemented; a
  picture of one element is a real ask and wants its own decision about
  scrolling, clipping and off-screen elements.

- **Screenshotting a session's page.** `get_page_content` with
  `format: "screenshot"` already does that and stays as it is. The two are
  complementary: session-addressed for a run you are driving, tab-addressed for
  a tab that is simply *there*.

- **Video or repeated capture.** One frame, on request.

## What the live proof showed

Run 2026-08-18 against real headed Chrome under a `shotproof` profile in the
user root, driving the built MCP server over stdio with no project — so the tool,
the HTTP route and the capture were all the shipped ones, and the browser was
staged out of band over raw CDP.

| Rule | Result |
| --- | --- |
| (1) no session, addressed by `targetId:` | 1689×1277 in **0.7s**, `content: ""`, `scope: "user"` |
| (3) live frame after the page changed while hidden | different bytes; **read by eye**: the red "AFTER — changed while BACKGROUNDED 2026-08-18T10:58:46Z" heading, fully rendered |
| (4) `full_page: true` | 1674×**3606** vs the viewport's 1277, 0.8s |
| (2) window **MINIMIZED** | photographed in **0.6s**, byte-identical to the shot taken after restoring the window |
| (7) `selector` / `max_chars` | refused in **0.0s**, before any browser work |
| — | `list_sessions` still 0; the text peek unchanged at 1619 chars |

Three defects came out of that run and none of them would have come out of the
suite, which is the argument for the rule above: the minimized capture hung
outright; the reported pixel size was a fabricated 1440×900; and a stuck capture
answered a later request with an earlier one's image. All three are fixed and
pinned — the first two in `tests/tab-screenshot.test.ts`, the third by never
hanging in the first place.

## Open questions

- Should the tool warn when the tab it photographs *does* have a live session
  or errand driving it? A peek already coexists with drivers by design
  (tab-peek verification item 4), and watching a run is a good reason to look.
  The case for a warning is that the page may move mid-capture — but the same
  is true of the text peek, which says nothing, so silence is at least
  consistent until someone is actually bitten.
