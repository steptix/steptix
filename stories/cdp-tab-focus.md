# CDP tab focus — "show me that tab"

> **Verification rule for this story.** "Done" means: (1) with a CDP browser
> holding several tabs and a **different** one on screen, `focus_cdp_tab
> {profile, target_id}` puts the named tab in front — confirmed by a human
> looking at the window, because no assertion in this repo can see a screen;
> (2) it works on a tab **no session owns**, including one the user opened by
> hand before anything attached — that is the case nothing today can reach;
> (3) from the host (e.g. Claude Code), *"show me the openrouter tab"*
> completes as list → the agent matches the title → focus, and the response
> echoes the tab's `title` and `url` so the agent can say what it brought
> forward; (4) a `target_id` matching nothing is an error naming both
> readings — already closed, or wrong browser — never a silent success, the
> same contract `close_cdp_tab` holds; (5) focusing changes **nothing else**:
> no tab closes, no session is created or re-bound, a run in flight on
> another tab keeps running and its steps still report their own
> `tab.targetId`; (6) a port in `foreign` is refused without
> `mcp.cdp.allowUnowned` — the same gate as attaching and closing; (7)
> attaching a session to an *existing* tab brings that tab forward, closing
> the gap [cdp-connection.md](cdp-connection.md) §Future left open; (8) a
> `switchPage`/`switchTab` step in **any headed run — launch mode included,
> since `headed` defaults to true** — brings the tab it switched to forward,
> so a watching human sees the tab the automation is actually driving, and a
> headless run makes no such call; (9) the focus route answers a plain
> `curl`, proving it is not MCP-private.

## Context

The request, in the user's own words:

> *"Is there a way to make a particular tab in focus so that it is visible,
> suppose I have multiple tabs open in the CDP browser?"*

Today: no. Not through any tool, any step, or any config. The framework can
list your tabs, run steps in one, and close one — but it cannot **show** you
one.

That is a strange gap for a feature whose entire premise is *"this is your
real, signed-in, visible browser"*. The user is looking at it while it works.

### What exists, and where each path dead-ends

| Capability | Status | Where |
| --- | --- | --- |
| List a browser's tabs, with stable ids | ✅ shipped | `list_cdp_browsers` → `running[].tabs[].targetId` |
| Close a named tab | ✅ shipped | `close_cdp_tab` ([cdp-tabs.md](cdp-tabs.md)) |
| Run steps in a named tab | ✅ shipped, at session creation | `config.cdp.tab: 'targetId:<id>'` |
| Bring a tab to the front on **launch** | ✅ shipped | [manager.ts:1219](../src/browser/manager.ts:1219) |
| Bring a tab to the front when we **open** one over CDP | ✅ shipped | [manager.ts:1284](../src/browser/manager.ts:1284) |
| Bring a tab to the front when we **attach to an existing** one | ❌ nothing | explicitly deferred, [cdp-connection.md:109](cdp-connection.md) |
| Bring **any** tab to the front, on demand | ❌ nothing | no tool, no route |

`page.bringToFront()` appears in exactly two places — the headed `launch()`
path and the CDP branch that opens a new tab — and both are for a tab **we
just created**. Every path that lands on a tab the user already had leaves it
wherever it was in the tab strip.

There is a `switchPage` step action (aliases `switchTab`, `switch_tab`), and
it is not this. It moves `PageTracker.activeIndex`
([manager.ts:592](../src/browser/manager.ts:592)) and returns the Page — no
focus call — so it changes **where automation goes**, not what is on screen.
It is also blind to the tabs that matter here: in CDP mode `PageTracker` is
constructed with the pre-existing pages in its ignore set
([manager.ts:1300](../src/browser/manager.ts:1300)), so it can only reach the
tab the session attached to plus tabs the run itself opened. The openrouter
tab the user opened by hand before attaching is not addressable by it at all.

That ignore-set decision is correct and stays — a test must not trip over the
user's other tabs — and it is precisely why the new verb cannot live inside a
session. It has to speak to the browser, not to a session's page tracker.
Same conclusion `close_cdp_tab` reached, for the same reason.

### How it reads afterwards

*"Show me the openrouter tab"*:

```jsonc
// 1. list_cdp_browsers → agent matches "openrouter" against titles/urls itself
// 2. focus_cdp_tab { profile: "default", target_id: "A1B2C3…" } →
{ "focused": true, "targetId": "A1B2C3…",
  "title": "OpenRouter — Docs", "url": "https://openrouter.ai/docs",
  "engine": "chrome", "profile": "default", "port": 16839,
  "warnings": [] }
// Agent: “Brought ‘OpenRouter — Docs’ to the front.”
```

*"Run the checkout steps in my cart tab, and let me watch"*:

```jsonc
// 1. list_cdp_browsers → cart tab is targetId D4E5F6…
// 2. run_steps { steps: [...], config: { cdp: { profile: "default",
//                                               tab: "targetId:D4E5F6…" } } }
//    → the tab now comes forward on attach (§3), so the user watches the
//      steps run instead of hunting for the right tab in the strip.
```

The agent does the fuzzy part — "openrouter" → which tab — because the agent
is a model reading a list. Same division [cdp-tabs.md](cdp-tabs.md) locked.

## Locked decisions

- **A separate verb, not a flag on something else.** "Show me tab X" is not
  "run steps in tab X" and must not cost a session, a model call, or a page
  navigation. It is also the one operation here that is genuinely free of
  consequence, so burying it inside a heavier call would be the wrong trade.

- **The agent matches; the tool takes an exact `targetId`.** Inherited from
  [cdp-tabs.md](cdp-tabs.md) §Locked, for consistency rather than for safety
  — focusing the wrong tab is a nuisance, not a loss. Two identical
  interfaces over one list beat two rules a model has to remember which is
  which.

- **No session guard, and no flag.** `close_cdp_tab` refuses a tab a live
  session is driving; this must **not**. "Show me what the test is doing" is
  the single most likely reason to call it, and the tab a session holds is
  exactly the tab the user wants to see. Focusing changes no automation
  state: Playwright drives a page by target, not by which tab is frontmost,
  so a run on another tab is unaffected — which is verification rule (5) and
  the one thing this story genuinely has to prove rather than assume.

- **Same ownership gate as attaching and closing.** Focusing a tab in
  someone else's browser yanks a human's screen and reveals which tab they
  are being shown. So the port must belong to a `running` entry for this
  project ([mcp-cdp-browser.md](mcp-cdp-browser.md) §6); `foreign` requires
  the human-held `mcp.cdp.allowUnowned` opt-in. Non-destructive is not the
  same as unobtrusive, and the gate is already there.

- **`focused: true` means the browser accepted it — and the field says so
  rather than pretending otherwise.** This is the deliberate opposite of
  `close_cdp_tab`'s "closed means gone", and the asymmetry is honest, not
  lazy. A closed tab has an observable absence to poll for; "is this tab
  frontmost, and is its window in front of every other application" has no
  reliable read over the DevTools HTTP surface, and on Windows the OS itself
  may decline to raise a window on a background process's say-so (§Risks).
  W0 is charged with finding an observable signal; **if it finds one the
  route confirms and the field means confirmed, and if it does not the field
  keeps this weaker meaning and the tool description states it.** What is
  forbidden is quietly reporting the strong contract while holding the weak
  one.

- **Three surfaces, one mechanism.** The new tool is the headline, but the
  same one-line call closes two existing gaps — attach-to-existing-tab (§3)
  and `switchPage` (§4). Shipping the tool alone would leave the framework
  able to show you a tab on request while still silently running behind the
  one you are looking at.

- **No "follow the run" mode.** Focus is a verb the caller issues, never an
  ambient behaviour that repeatedly grabs the screen as a run moves between
  tabs. See §Out of scope for why that is a different feature with a
  different failure mode.

## Design

### 1. The activate mechanism

Verified against **Chrome 150.0.7871.187** on Windows 11, against the live
browser this story was written from:

| Claim | Result |
| --- | --- |
| `GET /json/activate/<targetId>` exists on the same port as `/json/list` | yes — `200 "Target activated"` |
| `PUT` works too | yes — identical `200`, so the verb choice is free |
| an unknown id is distinguishable | yes — `404 No such target id: DEADBEEF` |
| it needs a Playwright/WebSocket connection | **no** — plain HTTP, so it reaches tabs no session owns |
| it refuses targets that are not tabs | **no** — `iframe` and `browser_ui` ids both answer `200 "Target activated"`; only `worker` refuses (`500 Could not activate target id`) |

So it is a drop-in sibling of the `closeTab()` that
[cdp-discovery.ts](../src/browser/cdp-discovery.ts) already wraps: same host,
same port, same 404 shape, same `encodeURIComponent` treatment of the id.
`Target.activateTarget` over the WebSocket is not needed.

That last row is why §2's shared-filter step is load-bearing rather than
tidy: the browser will happily "activate" an iframe or an omnibox, so
**anything the agent was never shown in the listing must be rejected by us,
not by the browser.**

**There is no second mechanism to fall back to.** An earlier draft of this
story reserved `Page.bringToFront` over a short-lived CDP connection as a
fallback if `/json/activate` turned out to select the tab without raising the
window. Adversarial review killed that: at Chrome 150.0.7871.187 — the exact
version measured above — both paths converge on the same call.
`/json/activate` reaches `WebContents::Activate()` →
`Browser::ActivateContents`, which does `tab_strip_model_->ActivateTabAt(index)`
followed by `window_->Activate()`; `Page.bringToFront` calls the *same*
`WebContents::Activate()` and adds only `Focus()` on the outermost contents,
which is renderer input focus, not a second window raise. **If Windows
declines to raise a backgrounded Chrome for one, it declines for the other.**

Two things follow. The comment at
[manager.ts:1214](../src/browser/manager.ts:1214) — cited in the earlier draft
as evidence that the OS raise is a separate, unsolved concern — is actually
evidence that the *shared* path works on this machine, since `bringToFront`
demonstrably raises a background window at launch. And the fallback was never
cheap anyway: `package.json` declares `"node": ">=18.17.0"`, which has no
built-in WebSocket client, so a CDP hop from the route would mean either
Playwright's `connectOverCDP` per call or a new dependency.

**What W0 must still establish** is therefore narrower and has only one
branch: does Windows honour `window_->Activate()` for a Chrome that is
behind another application, or minimised? Whatever the answer, it routes to
§Risks' documented-limitation-plus-`warnings[]` outcome. There is no
mechanism swap to decide.

### 2. The focus route

```
POST /cdp/browsers/:port/tabs/:targetId/focus?projectRoot=<abs>&allowUnowned=<bool>
  → { focused: true, targetId, title, url, engine, profile, port, warnings: [] }
```

Behind the existing auth middleware, beside the `DELETE` of
[cdp-tabs.md](cdp-tabs.md) §2. `POST` rather than `PUT`: this is an action on
a tab, not a replacement of one.

Order of operations, deliberately shorter than the close route's:

1. **Resolve the port to an owned running browser** via the registry —
   identical to the close route, `allowUnowned` honoured the same way. Not
   owned → 404 naming what the registry does know.
2. **Read the tab list** through the **shared page-type filter**
   (`toPageTabs`), and find `targetId`. Missing → 404 with the
   all-three-readings message (§6). Reusing the filter is not decoration, and
   §1 measured why: the browser returns `200 "Target activated"` for `iframe`
   and `browser_ui` ids as readily as for real tabs, so without the filter
   this tool would report success for having "focused" an omnibox. The
   `edge://…-dialog` case [cdp-tabs.md](cdp-tabs.md) found in live testing is
   the same hazard one step further in.
3. **Activate it**, and echo the `title`/`url` read in step 2 so the agent
   can name what it brought forward.

**No queue.** The close route serialises per port because two concurrent
closes can defeat the last-tab guard. Focus has no guard to defeat and no
irreversible outcome: two concurrent focuses simply mean the second wins,
which is what "focus" means. Adding a queue here would be cargo-culting the
neighbour's machinery.

**No confirm poll — and the observable that exists confirms only half.**
Chrome *does* report `/json/list` in most-recently-used order: at the 150 tag
the HTTP handler sorts targets by `GetLastActivityTime()` descending before
serialising, and that clock is bumped by `ActivateTabAt` — which runs
**whether or not the OS honoured `window_->Activate()`**. So a post-activate
read can confirm the tab was selected and is structurally blind to whether
the window came forward, which is the half W0 is actually about.

If W1 wants it, step 3 may gain that single read; it upgrades `focused` from
*accepted* to *this tab is selected in its window*, and no further. It must
not be described as confirming the tab is on screen — that is the
strong-contract-weak-truth trap §Locked forbids, in the one failure mode W0
exists to find. Edge's ordering is unverified; the source check above is
Chrome-only.

### 3. Attach brings the tab forward

[connectOverCdpSession](../src/browser/manager.ts:1246) calls
`page.bringToFront()` on the `tabSpec.kind === 'new'` branch
([manager.ts:1284](../src/browser/manager.ts:1284)) and not on the
attach-to-existing branch. The asymmetry has no defence — it is the item
[cdp-connection.md:109](cdp-connection.md) parked as a future enhancement,
and the measured trap in [cdp-tabs.md](cdp-tabs.md) §Context (*"the user
watches their carefully arranged cart sit untouched while steps run somewhere
else"*) is the same complaint one layer up.

One call, on the same non-fatal `try`/`catch` as its two neighbours — which
are **silent** (`catch { /* non-fatal */ }`), not warning-emitting. Match
them: a browser that refuses to raise a window should not fail an attach, and
inventing a new warning channel for it here would be scope this story has not
argued for.

### 4. `switchPage` brings the tab forward

`switchToAsync` moves the tracker's index and returns the Page; the step
executor then drives it ([step-executor.ts:1002](../src/runner/step-executor.ts:1002)).
Nothing raises it. In any **headed** run — the mode where a human is
watching — that means a `switchTab` step moves the automation behind the tab
the user is looking at, and the visible tab stops changing while the run
continues.

**The gate is headed, in both browser modes.** Not headed-CDP-only: `headed`
defaults to **`true`** ([defaults.ts:19](../src/config/defaults.ts:19)), a
launch-mode run's pages open as tabs in one visible window, and a human
watching that has the identical complaint. Headless is where the call is
pointless, and that is the only thing it is gated against. Read the gate off
the **active browser's** headedness rather than global config —
`openBrowser` can override `headed` per browser — and keep it non-fatal.

The call goes in the **step executor**, beside the existing switch, not
inside `switchToAsync`. The honest reason is layering, not side effects:
`PageTracker`'s constructor takes `(page, ignoredPages)` and knows nothing
about headedness or CDP, while the step executor already holds
`config.browser.headed` and can reach the active browser. (An earlier draft
justified this by claiming the tracker is used by
[cdp-tabs.md](cdp-tabs.md)'s close-guard sweep, which must stay side-effect
free. That is false and would have misled anyone who checked: the sweep goes
through `resolvedTargetIds()` and `activeTabRef()`, and the only callers of
`switchToAsync` in the whole tree are the two step-executor sites this
section is about — `:823` for `openPage` and `:1005` for `switchPage`.)

It applies to `openPage` on the same grounds: a newly opened tab the run is
about to drive should be the one on screen.

### 5. The MCP tool

```
focus_cdp_tab { target_id,
                profile? | port?,   // exactly one, like config.cdp
                engine?,            // disambiguates profile
                project_root? }
```

A thin client of §2. Profile → port resolution reuses `resolveCdpTarget`
([src/mcp/cdp.ts](../src/mcp/cdp.ts)); a registry-resolved port skips the §6
gate by construction, an agent-supplied `port` is gated as today. Auto-start
on, like `close_cdp_tab` — it acts on live browser state, so a stopped
Sessions API server should be started rather than surfaced as ECONNREFUSED.

Description draft — the behaviours that surprise, per
[mcp-server.md](mcp-server.md) §7:

> Bring one tab of a CDP browser to the front, so the user can see it. Takes
> the exact `targetId` from `list_cdp_browsers` — call that first and match
> the user's words against the titles and urls yourself.
>
> This moves a real window on the user's screen. Say which tab you brought
> forward, not just that it worked.
>
> It changes nothing else: no tab is closed, no session is created, and a run
> in flight elsewhere keeps running — automation drives a tab whether or not
> it is visible. So this is for *showing a human something*, and it is not a
> way to make steps run somewhere; that is `config.cdp.tab` on a new session.

Inventory updates [page-content.md](page-content.md) proved are easy to miss:
`usage.ts`, the README tool table, `server-start.ts`'s auto-start list, the
`mcp-seam.test.ts` tool list, **both** manifests in
`mcp-schema-dialect.test.ts`, and the `argumentsFor()` table in
`mcp-content-blocks.test.ts` (§Tests).

**The tool count: increment, never assert a number.** An earlier draft said
"11 → 12" and was already stale when written — `run_settings` was landing in
the working tree at the same time, so `registerTool` is called **12** times
today and this story makes it 13. Whichever order these two land in, an
absolute number is wrong for one of them. So: increment every count sentence
in [mcp-server.md](mcp-server.md) by one, and grep for **both** the numeral
and the spelled word — §2's opening is `Eleven tools` (word, line 218), while
`all 11 schemas` (line 467) and `**11** tools` (line 1139) are numerals, so a
numeral-only grep finds two of the three. There is a fourth sentence with no
count in it that still needs editing: line 220's *"the four added since are
specced elsewhere"*, which enumerates the post-launch tools by name and must
gain `focus_cdp_tab`.

### 6. Errors

MCP pre-flight rows in [src/mcp/errors.ts](../src/mcp/errors.ts) — returned,
never thrown, no TB codes.

| Condition | Message names | Next action it must offer |
| --- | --- | --- |
| `target_id` not found in that browser | the id, and both readings — already closed, or a different browser's id | `list_cdp_browsers` for the current list |
| **404 with no server message** — the route itself is missing, i.e. a Sessions API server from an older build | that the server predates this route, not that the tab is gone | rebuild `dist/` and restart the server |
| port not `running` / foreign | which list the port was found in, and `mcp.cdp.allowUnowned` | pick from `running`, launch from `available`, or ask the user to set the opt-in |
| both or neither of `profile`/`port` | the exactly-one rule | — (same wording as `close_cdp_tab`'s) |
| activate accepted but the tab is demonstrably not frontmost (only if W0 yields an observable) | the id and that the browser accepted but did not raise it | try again, or ask the user to click the window — the OS may be refusing the raise |

## Out of scope

- **A "follow the run" mode** that re-focuses as automation moves between
  tabs. Different feature, worse failure mode: an ambient screen-grabber
  fighting a human for their own pointer, firing on every `switchPage` of a
  long run. If it is ever wanted it is a session-level opt-in with an off
  switch, not a property of this verb.
- **Focusing a window rather than a tab.** Same answer as
  [cdp-tabs.md](cdp-tabs.md) §Out of scope: the tab list is flat and carries
  no window membership, and DevTools has no focus-window verb. Focusing any
  tab of a window necessarily brings that window forward, so "show me that
  window" already decomposes.
- **Minimising, restoring, moving or resizing windows.** Needs
  `Browser.setWindowBounds` over a WebSocket and answers no request anyone
  has made.
- **Focusing launch-mode session browsers over MCP.** They are disposable —
  they die with their session, and there is no persistent tab for a human to
  ask about by name. (Not "usually headless": `headed` defaults to true. The
  disposability argument is the whole argument.) In-run behaviour is covered
  by §4.
- **Focusing a tab in an incognito window.** W0 for [cdp-tabs.md](cdp-tabs.md)
  established incognito tabs do appear in `/json/list`, so this probably works
  for free — but "probably" is not a contract, and the attach half is already
  known broken for incognito (§Risks there). Untested, unclaimed.
- **Anything in flick's UI.**

## Composition

| File | Change |
| --- | --- |
| [src/browser/cdp-discovery.ts](../src/browser/cdp-discovery.ts) | `activateTab(port, targetId, timeoutMs, fetchFn)` beside `closeTab` — same signature, same 404 handling. |
| [src/server/api-server.ts](../src/server/api-server.ts) | The `POST …/focus` route: ownership, shared filter, activate, mapping to 404. |
| [src/mcp/schemas.ts](../src/mcp/schemas.ts) | `focusCdpTabInput`/`Output`. Every field `.nullable()`, never optional. |
| [src/mcp/tools.ts](../src/mcp/tools.ts) | Register `focus_cdp_tab`; gate; description. |
| [src/mcp/api-client.ts](../src/mcp/api-client.ts) | `focusCdpTab` — id and targetId via `encodeURIComponent`. |
| [src/mcp/errors.ts](../src/mcp/errors.ts) | The §6 rows. |
| [src/browser/manager.ts](../src/browser/manager.ts) | §3's one call on the attach-to-existing branch. |
| [src/runner/step-executor.ts](../src/runner/step-executor.ts) | §4's call after `switchPage` and `openPage`. |
| `usage.ts`, README, `server-start.ts`, seam + dialect manifests, `mcp-content-blocks.test.ts` | Inventories, and the count sentences — **increment, do not assert a number** (§5). |

## Tests

House pattern: no `supertest`, `listenOnRandomPort()`, and `tsconfig.json`
excludes `tests` so lint does not typecheck them.

### Route (real app over HTTP)

- Focus an existing tab → 200, echoes title/url read through the shared
  filter.
- Unknown target → 404 carrying both readings; unowned port → 404; with
  `allowUnowned` → 200.
- **The lookup uses the listing's filter**, and this one is not hypothetical:
  §1 measured the browser answering `200 "Target activated"` for `iframe` and
  `browser_ui` ids. Assert that an id of each kind, and a `*-dialog` surface
  that `/json/list` reports as `type: 'page'`, are all refused — because the
  agent was never shown them. This is the drift guard
  [cdp-tabs.md](cdp-tabs.md) needed, and the one that fails only in
  production.
- Auth required; idle monitor bumped.

### MCP seam (`InMemoryTransport`)

- `focus_cdp_tab` end to end against a faked client; `structuredContent`
  complete; text summary names the tab's title.
- Exactly-one `profile`/`port` refusal; profile resolution skips the gate;
  raw `port` still gated; foreign refused naming `allowUnowned`.
- The new tool appears in every inventory guard — those fail first by design.
- **The content-block guard** in
  [tests/mcp-content-blocks.test.ts](../tests/mcp-content-blocks.test.ts)
  needs a row in its arguments table, and will fail until it gets one. That
  is the guard working: a new tool cannot ship without its data reaching
  content-rendering hosts.

### Unit

- `activateTab` maps 200 → ok, 404 → `notFound`, a thrown fetch → `error`;
  the target id is percent-encoded. (`500` is reachable too — §1 measured it
  for a `worker` id — so it must not fall through to "ok".)
- §4's focus call **is** made in a headed launch-mode run, **is not** made in
  headless, and a throw from it does not fail the step. The first of those is
  the one that would silently regress into CDP-only, which is what the
  earlier draft of this story specified.

### Live (manual, required to merge)

The parts no automated test can reach, and the reason rule (1) names a human:

- Two tabs, the *other* one visible → focus the first → it is on screen.
- The browser window behind another application → focus → does the window
  come forward, or only the tab within it? **This is W0's headline
  question.** It no longer decides between two mechanisms (§1) — it decides
  what the tool description and §Risks have to admit.
- Window minimised → what happens (§Risks).
- A tab that a live session is running steps on → focus it → the run
  continues and its steps still report their own `tab.targetId`
  (verification rule 5, on the streaming path — the non-streaming response
  has never carried `tab`, a trap [cdp-tabs.md](cdp-tabs.md) §Tests records).
  **Include a screenshot-bearing step**, so rule (5) covers the rendering
  layer and not just the driving layer: everything above the renderer is
  target-addressed and provably unaffected, but "does `Page.captureScreenshot`
  render a backgrounded tab of a headful browser identically" is the one part
  of that claim nobody here has measured.
- Both engines: Chrome and Edge. `/json/list` MRU ordering is source-confirmed
  for Chrome only (§2); if the confirming read is implemented, Edge needs its
  own check.

## Risks / open

- **Windows may refuse to raise the window.** The OS restricts which process
  can take foreground focus; a background process asking often gets a
  flashing taskbar button instead of a raised window. Chrome is the
  foreground-requesting process here, not us, which probably helps — but
  "probably" is why this is W0's headline question and why `focused: true`
  starts life meaning *accepted*. If the raise proves unreliable, the honest
  outcome is a documented limitation and a `warnings[]` entry. **There is no
  louder mechanism to escalate to** — §1 establishes that `/json/activate`
  and `Page.bringToFront` issue the same `window_->Activate()`, so this is
  the ceiling, not a first attempt.
- **Multi-monitor and virtual desktops.** A raised window on another monitor
  or another desktop is "visible" by every check we can make and invisible to
  the user. Nothing to do about it; worth saying in the tool description if
  W0 sees it.
- **Focus fights the user.** The one call is polite; a model that calls it in
  a loop is not. Mitigated by it being an explicit verb (§Out of scope's
  no-ambient-mode decision) rather than by a rate limit.
- **§4 changes existing behaviour** for every **headed** run with a
  `switchTab` or `openPage` step — launch mode included, since `headed`
  defaults to true, so the blast radius is wider than "CDP runs". That is the
  point, but it is a behaviour change in a code path with live tests, so it
  lands with its own regression test rather than as a rider on the tool.
- **The tool count is a moving target.** `run_settings` was landing in the
  working tree while this story was being written, so the count sentences in
  [mcp-server.md](mcp-server.md) will have been touched by that work — or
  will still be stale from it — by the time this starts. Increment rather
  than assert (§5), and expect an ordering dependency.
- **Two inventories are already drifting** from the in-flight `run_settings`
  work: `src/mcp/usage.ts` and the README tool table have no
  `get_run_settings` entry while the test manifests do. Do not "fix" those as
  part of this story — they belong to that one — but do not copy the omission
  either.

# Plan

## Workstream graph

```
W1 server: activateTab + route  ──> W2 MCP: focus_cdp_tab + errors + inventories
W3 attach + switchPage focus       (independent — uses page.bringToFront, already proven)
W0 does Windows honour the raise?  (independent, does NOT gate W1 — see below)
```

## Workstreams

**W0 — the honesty check, and it no longer blocks anything.** A human at the
screen: launch each engine via the existing registry, open three tabs, put
another application in front, `/json/activate` one tab, and look. Then repeat
minimised, and on a second monitor.

It was originally drawn as a gate on W1, on the theory that a failed raise
would send the route to `Page.bringToFront` instead. §1 removed that branch —
both paths issue the same `window_->Activate()`, so there is nothing for W1
to decide and no reason to hold it. What W0 changes is **what we are allowed
to say**: the tool description, §Risks, and whether a `warnings[]` entry
fires. Run it before merge, not before writing code.

Secondary, cheap while you are there: does `/json/list` reorder after an
activate on **Edge**? Chrome's MRU ordering is already source-confirmed
(§2); Edge is closed source and needs the empirical check if W1 implements
the confirming read.

**W1 — server.** §2's route, §1's `activateTab`. The shared-filter test
first: it is the one that fails silently in production and loudly nowhere
else.

**W2 — MCP tool.** §5, §6. Inventories including the content-block guard's
arguments table, which will fail loudly and correctly until the new tool is
added to it.

**W3 — the two existing gaps.** §3 and §4. Both use `page.bringToFront()`,
which is already in the codebase and already works at launch. Ships first if
convenient — §3 alone is the cheapest fix to the attach-got-the-wrong-tab
complaint, and it is a one-line change to a branch whose sibling already does
it. §4 is the riskier half: it changes behaviour for every headed run, so it
carries the regression test §Tests names.

## Repo gotchas

- **Rebuild `dist/` and restart the Sessions API server** before testing by
  hand — the MCP server the host (e.g. Claude Code) spawns runs `dist/`, and
  the route lives in the separately-running server process. No TestBench
  extension bump: this is all server-side.
- **Output schemas are SDK-validated** — every new field `.nullable()`, never
  optional.
- **`it.each(...)` options go in the second position** in Vitest 4; the
  trailing-options form was removed.
- **The full vitest run is intermittently flaky** (worker-pool crash, all
  files at once, ~8 s, 0 tests). Re-run the single file before believing a
  regression.
