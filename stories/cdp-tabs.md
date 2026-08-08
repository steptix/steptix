# CDP tabs — the agent lists them, picks one, closes one

> **Verification rule for this story.** "Done" means: (1) `list_cdp_browsers`
> on a running owned browser reports every page tab with `targetId`, `title`,
> `url`, and a `sessionId` naming the live session driving it, or null; (2)
> from the host (e.g. Claude Code), *"close the openrouter tab"* completes as:
> list → the agent matches the title/url → `close_cdp_tab {profile, target_id}`
> → that tab is gone from the browser window and from a fresh list, every
> other tab is untouched, and the browser process is still running; (3)
> `close_cdp_tab` echoes the closed tab's `title` and `url`, and returns
> `closed: true` only after the target has actually disappeared from the
> browser's tab list — never merely because the close was accepted; (4)
> closing a tab a live session is driving is refused, naming that session id
> and `close_session`; after the session is closed the same call succeeds; (5)
> closing the browser's last tab without `allow_browser_exit: true` is
> refused naming the flag and the consequence; with it, the tab closes, the
> response reports `browserExited: true`, the profile moves to `available`,
> and `start_cdp_browser` relaunches it still signed in; (6) a `target_id` matching
> nothing is an error naming both readings — already closed, or wrong browser
> — never a silent success; (7) `run_steps` with
> `config.cdp: {profile, tab: 'targetId:<id>'}` on a new session runs its
> steps in exactly that tab, proven by the step results' own `tab.targetId`,
> and `list_sessions` then shows the binding as `tab: {targetId, url}`; (8) a
> port in `foreign` is refused without `mcp.cdp.allowUnowned` — the same gate
> as attaching; (9) the close route answers a plain `curl`, proving it is not
> MCP-private. A vitest seam suite through a real in-memory MCP client, route
> tests through the real `createApiServer` app over HTTP, and a live pass
> against a real Edge with a hand-opened openrouter.ai tab are all part of
> the contract.

## Context

Two requests, in the user's own words, both aimed at the persistent CDP
browser the framework launched for them
([mcp-cdp-browser.md](mcp-cdp-browser.md)):

1. *"Close the openrouter tab."* The user has a signed-in Edge running with
   eight tabs; one is openrouter.ai docs; they want the agent to tidy it away.
2. *"Run the checkout steps in the tab where I set up the cart."* The user
   hand-arranged state in a specific tab and wants steps to run **there**, not
   in a fresh tab.

**Half of this already shipped.** What exists today, and where each request
dead-ends:

| Capability | Status | Where |
| --- | --- | --- |
| List a browser's tabs, with stable ids | ✅ shipped | `list_cdp_browsers` → `running[].tabs: [{targetId, title, url}]` |
| Run steps in a chosen tab | ✅ shipped, at session creation | `run_steps` → `config.cdp: {profile, tab: 'targetId:<id>'}` ([cdp-session-binding.md](cdp-session-binding.md)) |
| See which step ran in which tab | ✅ shipped | step results carry `tab: {label, targetId, url, title}` ([mcp-cdp-browser.md](mcp-cdp-browser.md) §11) |
| **Close a tab** | ❌ nothing | no tool, no route |
| See which **session** is on which **tab** | ❌ half | `list_sessions` reports `cdp: {port, profile}` but not the tab; the tab list doesn't name sessions |

So request 2 is *possible* today and request 1 is *impossible*. Walking them
through makes the gaps concrete.

**Request 1 today.** The agent can see the tab —

```jsonc
// list_cdp_browsers →
{ "running": [ { "engine": "edge", "profile": "default", "port": 54321,
    "tabs": [
      { "targetId": "A1B2C3…", "title": "OpenRouter — Docs", "url": "https://openrouter.ai/docs" },
      { "targetId": "D4E5F6…", "title": "Cart — Shop", "url": "https://shop.example/cart" }
    ] } ] }
```

— and then has no verb. There is no close tool. The tempting workaround, a
`run_steps` call with the step *"Close the OpenRouter tab"*, does not work
either, for a reason that is easy to miss: in CDP mode every tab that existed
before the session attached is deliberately **invisible to the session** —
[manager.ts:1151](../src/browser/manager.ts:1151) puts pre-existing pages on
the tracker's ignore list, and [manager.ts:281](../src/browser/manager.ts:281)
drops them on adoption. The AI's `closePage` action can only close tabs the
session itself opened. That invisibility is correct (a test should not trip
over the user's other tabs) and it means the workaround costs a session, a
model call, *and* still fails.

**Request 2 today.** The mechanism exists end to end — list, take the
`targetId`, pass `config.cdp: {profile: 'default', tab: 'targetId:D4E5F6…'}`
on a **new** session — but the agent flying it is half blind:

- Nothing tells it, at the moment of the `run_steps` call, that `tab`
  defaults to `new`. An agent that lists tabs, finds the cart, and attaches
  with `{profile: 'default'}` alone gets a **fresh tab**, silently, and the
  user watches their carefully arranged cart sit untouched while steps run
  somewhere else.
- Once two sessions exist on one browser (allowed and useful —
  [mcp-cdp-browser.md](mcp-cdp-browser.md) §Locked), `list_sessions` cannot
  say which session is on which tab. The agent has to dig through
  `get_last_run` step results to reconstruct it.

So this story is **one new verb plus visibility**, not a new subsystem:

- `close_cdp_tab` — the missing verb (MCP tool + Sessions API route).
- `list_cdp_browsers` tabs gain `sessionId` — tab → session.
- `list_sessions` gains `tab: {targetId, url}` — session → tab.
- `run_steps` / `run_test_file` descriptions spell out the select-a-tab flow.

### How the two requests read afterwards

*"Close the openrouter tab"*:

```jsonc
// 1. list_cdp_browsers → agent matches "openrouter" against titles/urls itself
// 2. close_cdp_tab { profile: "default", target_id: "A1B2C3…" } →
{ "closed": true, "targetId": "A1B2C3…",
  "title": "OpenRouter — Docs", "url": "https://openrouter.ai/docs",
  "engine": "edge", "profile": "default", "port": 54321,
  "remainingTabs": 7, "browserExited": false, "warnings": [] }
// Agent: “Closed ‘OpenRouter — Docs’. 7 tabs left.”

// Had it been the browser's LAST tab:
//   → refused: “…closing it will close the browser. The profile stays
//      signed in on disk; pass allow_browser_exit: true if that is what
//      you want.”
//   retry with { …, allow_browser_exit: true } →
//   { "closed": true, "browserExited": true, "remainingTabs": 0, … }
```

*"Run the checkout steps in the tab where I set up the cart"*:

```jsonc
// 1. list_cdp_browsers → cart tab is targetId D4E5F6…
// 2. run_steps { steps: ["Click Checkout", …],
//                config: { cdp: { profile: "default", tab: "targetId:D4E5F6…" } } }
//    → step results each carry tab.targetId "D4E5F6…" — proof it ran there
// 3. list_sessions →
{ "sessions": [ { "sessionId": "mcp:x", "status": "active",
    "cdp": { "port": 54321, "profile": "default" },
    "tab": { "targetId": "D4E5F6…", "url": "https://shop.example/cart" } } ] }
```

The agent does the fuzzy part — "openrouter" → which tab — because the agent
is a model reading a list; the tools take exact ids. That division is the
same one [page-content.md](page-content.md) locked for reading pages:
whoever called this does the understanding.

## Locked decisions

- **The agent matches; the tool takes an exact `targetId`.** `close_cdp_tab`
  accepts no `url~`/`title~` selector. A destructive verb with fuzzy matching
  closes the wrong tab on the day two tabs both say "OpenRouter"; the list is
  one call away and the model is better at "which one did the user mean" than
  any substring rule. The *attach* selectors (`config.cdp.tab`) keep their
  fuzzy forms — attaching to the wrong tab is recoverable, closing it is not.

- **`targetId` survives navigation, and that is why it is the address.** A
  tab keeps its `targetId` for life; the title and url in the list are merely
  how the agent recognises it. A close issued after the tab navigated still
  closes the tab the agent was shown. (Same reason
  [flick-vscode-cdp-attach.md](flick-vscode-cdp-attach.md) row 2 made it the
  preferred attach selector.)

- **A tab a live session is driving is refused, with no `force` flag.**
  Yanking a session's page mid-run turns its next step into a confusing
  page-closed failure. The refusal names the session id; `close_session` is
  the sanctioned door, and after it the same close succeeds. The check covers
  **all** of a session's tracked pages, not just its active one — a session
  can `switchPage` back to any of them.

- **The last tab may be closed — behind an explicit flag — and closing it
  closes the browser.** Chromium ties the process's life to its last
  window; there is no zero-tab browser to leave behind (on Windows/Linux —
  §Risks for the caveats W0 measures). So "close the last tab" *is* "stop
  the browser", and the design says so instead of hiding it: without
  `allow_browser_exit: true` the call is refused naming the flag and the
  consequence; with it, the browser exits and the response reports
  `browserExited: true`. Stating destructive intent in the call is the
  `reset: true` pattern of [mcp-cdp-browser.md](mcp-cdp-browser.md) §12.
  Three facts keep this contained: a live session anywhere on the browser
  implies a second tab, so a permitted last-tab close can never strand a
  session mid-run (the only overlap — a session driving that very tab — is
  already guard 4's refusal); the profile loses nothing — signed-in state
  is on disk, the profile reappears under `available`, and relaunching
  returns it logged in (the closed-browser-is-not-a-lost-browser rule of
  [mcp-cdp-browser.md](mcp-cdp-browser.md) §7); and the stale
  `DevToolsActivePort` left behind is already handled by the registry's
  reachability probe. Run teardown is unchanged — nothing but this
  flagged, deliberate call ends a browser
  ([mcp-cdp-browser.md](mcp-cdp-browser.md) §8 still holds).

- **`closed: true` means gone, not accepted.** The DevTools close endpoint
  acknowledges before the tab disappears. The route polls the tab list until
  the target is absent (bounded, ~2 s) and only then reports success — so
  the response is a fact the agent can relay, and `remainingTabs` is a real
  count, not arithmetic.

- **An unknown `target_id` is an error, never a silent success.** "Already
  closed" and "this id belongs to a different browser" are indistinguishable
  server-side, and treating the pair as idempotent success would swallow the
  second. The error states both readings and the next action (re-list).

- **Same ownership gate as attaching.** Closing tabs in a browser is at
  least as intrusive as driving one, so the port must belong to a `running`
  entry for this project ([mcp-cdp-browser.md](mcp-cdp-browser.md) §6);
  `foreign` requires the human-held `mcp.cdp.allowUnowned` opt-in. Profile
  addressing resolves MCP-side exactly as `config.cdp.profile` does
  ([cdp-session-binding.md](cdp-session-binding.md)), so the wire stays
  port-shaped.

- **Selecting a tab stays a session-creation act. No re-binding.** "Run
  steps in tab X" = create a session with `cdp.tab: 'targetId:X'`; a
  different tab is another session, and parallel sessions on one browser are
  already allowed. A `select_tab`-on-existing-session tool would break the
  locked invariant that a session's browser and tab are fixed at creation —
  the invariant the dropped-config warning exists to defend. Sessions are
  the cheap resource here; invariants are not.

- **Scope is the framework's CDP browsers.** Disposable launch-mode browsers
  die with their session and their popups are already closable in-run by the
  AI's `closePage` action; they need no MCP-level tab verb. The tool name
  says the scope — `close_cdp_tab`, following the deliberate `cdp` prefix
  rule of [mcp-cdp-browser.md](mcp-cdp-browser.md) §5.

## Design

### 1. The tab list names its sessions

`GET /cdp/browsers` already probes each running owned browser for its tabs.
Each tab entry gains one field:

```
running[].tabs: [{ targetId, title, url, sessionId: string | null }]
```

`sessionId` is the live managed session whose page tracker holds that
`targetId` — the Sessions API server joins against its own sessions, whose
per-page target ids are already resolved and cached at adopt time
([mcp-cdp-browser.md](mcp-cdp-browser.md) §11), so the join is a map lookup,
not a CDP round-trip. Null for a tab nothing is driving.

This is what makes the close refusal (§2) *predictable* rather than a
surprise: the agent can see "that tab is session `mcp:x`'s" before trying.
Foreign browsers are unaffected — their tabs are already withheld.

The MCP output schema adds the field as `.nullable()`, never optional
(missing keys are fatal to `structuredContent` validation).

### 2. The close route

```
DELETE /cdp/browsers/:port/tabs/:targetId?projectRoot=<abs>&allowBrowserExit=<bool>
  → { closed: true, targetId, title, url,
      engine, profile, port, remainingTabs, browserExited, warnings: [] }
```

Behind the existing auth middleware, beside the two routes of
[mcp-cdp-browser.md](mcp-cdp-browser.md) §4. Order of operations:

1. **Resolve the port to an owned running browser** via the registry. Not
   owned → 404 naming what the registry does know.
2. **Read the tab list** and find `targetId`. The same page-type filtering
   the listing applies (`type:'page'`, `devtools://` and extension pages
   excluded) — shared helper, not a re-implementation, so the close can
   never refuse or count tabs the list would not show. Missing → 404 with
   the both-readings message (§Locked).
3. **Refuse if a live managed session holds it** (409, naming the session).
4. **If it is the last page tab, require `allowBrowserExit`** — refuse
   (409) without it, naming the flag and that the browser will exit.

   *These two were originally the other way round, on the grounds that the
   common refusal should be the cheap one. That was wrong: a one-tab browser
   driven by a session is entirely reachable, and the last-tab refusal then
   fires first and tells the caller to pass `allow_browser_exit: true` —
   advice that leads straight into a different refusal. A remedy that does
   not work costs more than the check it saved.*

   **Concurrent closes against one browser must be serialised by the caller**
   (the route does, per port). Guard 4 reads a tab list to decide whether
   this is the last tab; two overlapping closes both read the same pre-close
   list, both conclude they are not closing the last tab, and the browser
   exits with neither caller having asked — the one guarantee
   `allow_browser_exit` exists to give, bypassed.
5. **Close it, then confirm it is gone.** For an ordinary tab: poll the
   tab list until the id is absent, bounded (~2 s), and report the count
   observed. For a last tab the success signal inverts — the DevTools
   endpoint dies **with** the process, so "gone" means the port no longer
   answers, and that is what `browserExited: true` reports. A process that
   outlives its last tab (macOS; Edge background modes — §Risks) is
   reported honestly: `browserExited: false`, a warning, and the registry
   still counts the profile as `running`. A poll that exhausts its budget
   is an error stating the state is unknown, not a `closed: true`.

**Closing mechanism — W0 verified it; the fallback is not needed.** The
registry already speaks the browser's DevTools HTTP surface
(`/json/version`, `/json/list`); `/json/close/<targetId>` is the same
surface's close verb and needs no Playwright connection at all. Measured on
Windows 11, **Chrome 150.0.7871.187 and Edge 151.0.4129.59**:

| Claim | Result |
| --- | --- |
| `GET /json/close/<id>` closes an ordinary tab | yes — `200 "Target is closing"`, both engines |
| the acknowledgement means the tab is gone | **no** — ack in 1–5 ms, gone from `/json/list` at 7 ms (Chrome) / 41 ms (Edge) |
| an unknown id is distinguishable | yes — `404 No such target id: …`, so the browser itself separates "already closed" from "closed just now" |
| closing the last tab exits the process | yes — port stopped answering after 95 ms (Chrome) / 286 ms (Edge) |
| the process really dies (Startup Boost / background modes) | yes, both engines exited cleanly; no resident process |
| `DevToolsActivePort` is left behind | yes, stale — already handled by the registry's reachability probe |
| incognito-context tabs appear in `/json/list` and close | **yes**, both engines — see §Risks for the half that does not work |

So `Target.closeTarget` over the WebSocket is not needed, and the
acknowledgement gap is measured rather than assumed — which is the whole
argument for `closed: true` meaning *gone*.

**Steps 4→5 carry a TOCTOU** — a session could bind the tab between check
and close. Same class as
[issues/039](../issues/039-toctou-between-confinement-check-and-read.md),
recorded rather than solved; the window is milliseconds and the failure mode
(a session's page closes under it) is the one the check already makes rare.
A tab driven by something *outside* this Sessions API server — another
server instance, a human's own interaction — is unknowable and stays the
author's responsibility, consistent with "parallel sessions on one browser
are allowed, and the author owns the consequences".

### 3. The MCP tool

```
close_cdp_tab { target_id,
                profile? | port?,      // exactly one, like config.cdp
                engine?,               // disambiguates profile, as in config.cdp
                allow_browser_exit?,   // required true to close a browser's last tab
                project_root? }
```

A thin client of §2, like every other tool. Profile → port resolution
reuses `resolveCdpTarget` ([src/mcp/cdp.ts](../src/mcp/cdp.ts)); a
registry-resolved port skips the §6 gate by construction, an agent-supplied
`port` is gated as today.

Description draft — the behaviours that surprise, per
[mcp-server.md](mcp-server.md) §7:

> Close one tab in a CDP browser this project launched. Takes the exact
> `targetId` from `list_cdp_browsers` — call that first and match the
> user's words against the titles and urls yourself; there is no fuzzy
> matching here, because closing the wrong tab is not recoverable. This
> closes a real tab in the user's own signed-in browser window. Refused if
> a session is driving the tab (close the session first). Closing the
> browser's **last** tab closes the browser itself and requires
> `allow_browser_exit: true` — the profile keeps its signed-in state on
> disk, and `start_cdp_browser` brings it back.

Inventory updates that [page-content.md](page-content.md) proved are easy
to miss: `usage.ts`, the README tool table, and `server-start.ts`'s
auto-start list (`close_cdp_tab` acts on live state, so it may auto-start
the server like the other action tools — decided at plan time, but it must
appear in exactly one of the two lists).

### 4. Selection and visibility — finishing what exists

Nothing new to invent; two additions close the loop:

- **`list_sessions` gains `tab: {targetId, url} | null`** — the session's
  active page, from the tracker's cached target id and the page's
  last-known url. Deliberately **no `title`**: a title read is a round-trip
  into the page and one wedged page would stall a listing that already
  carries a timeout for exactly that reason
  ([cdp-session-binding.md](cdp-session-binding.md) §Locked). Works for
  launch-mode sessions too — target ids are cached in both modes.
- **`run_steps` / `run_test_file` descriptions** gain one sentence beside
  the existing CDP paragraph: *to run in an existing tab, take a `targetId`
  from `list_cdp_browsers` and pass `config.cdp.tab: 'targetId:<id>'` on a
  **new** session — without `tab`, a new tab is opened.* That last clause
  is the trap measured in Context; the schema documents it, but the schema
  is not what the model reads at call time.

Composed with what already shipped, this also answers *"what's on the
openrouter tab?"* with no new read surface: bind a session to the tab
(`tab: 'targetId:…'` or `'active'`), then `get_page_content` — the tab
targeting that [page-content.md](page-content.md) deferred arrives via the
addressing scheme it predicted, and its active-page-only rule stands.

### 5. Errors

MCP pre-flight rows in [src/mcp/errors.ts](../src/mcp/errors.ts) — returned,
never thrown, no TB codes. Every message: what was refused, why, the next
action.

| Condition | Message names | Next action it must offer |
| --- | --- | --- |
| `target_id` not found in that browser | the id, and both readings — already closed, or a different browser's id | `list_cdp_browsers` for the current list |
| tab is held by a live session | the session id and its tab | `close_session` that session, then retry — or leave it alone if the session is wanted |
| last page tab, no `allow_browser_exit` | that this is the browser's last tab, closing it closes the browser, and the profile stays signed in on disk | pass `allow_browser_exit: true` if that is intended, or leave the tab |
| port not `running` / foreign | which list the port was found in, and `mcp.cdp.allowUnowned` | pick from `running`, launch from `available`, or ask the user to set the opt-in |
| both or neither of `profile`/`port` | the exactly-one rule | — (same wording as `config.cdp`'s) |
| close accepted but tab (or, for a last tab, the process) still present after the poll budget | the id and that the state is unknown | re-list before retrying |

## Out of scope

- **Re-binding an existing session to another tab** (rejected, §Locked).
- **`open_tab` / navigating a tab without steps.** `config.cdp.tab: 'new'`
  plus a navigation step already covers "start me a fresh tab there".
- **Closing launch-mode session tabs over MCP.** In-run `closePage` covers
  it; the disposable browser dies with the session anyway.
- **`DELETE /cdp/browsers` / a `stop_browser` tool.** Still no dedicated
  verb — but no longer pretended impossible: a flagged last-tab close *is*
  how this framework stops a browser, stated plainly rather than shipped
  under a different name by accident. A dedicated route stays the flick
  follow-up [mcp-cdp-browser.md](mcp-cdp-browser.md) §4 named.
- **Closing or addressing windows.** A window is not another browser: one
  browser process (one profile, one port, one cookie jar) holds any number
  of windows, and another *browser* is another profile. The protocol
  agrees — the tab list is flat, with no window membership, and DevTools
  has no close-window verb at all; a window simply disappears when its
  last tab does. So "close that window" already decomposes into
  `close_cdp_tab` over its tabs, each close individually guarded, the
  final one flag-gated when it is also the browser's last (§2). The one
  missing ingredient is membership — *which* tabs share a window — which
  would be a `windowId` field on the tab list via
  `Browser.getWindowForTarget`; that needs a CDP WebSocket hop where
  today's listing probe is pure HTTP, and no current request justifies it.
  If it becomes real, it is a listing field, not a new destructive verb.
- **A `tab` parameter on `get_page_content`.** Stays deferred as
  [page-content.md](page-content.md) decided; §4 shows the composition that
  makes it unnecessary.
- **Fuzzy tab matching server-side**, window focus/ordering, moving tabs
  between windows, and anything in flick's UI.

## Composition

| File | Change |
| --- | --- |
| [src/browser/cdp-discovery.ts](../src/browser/cdp-discovery.ts) | `closeTab(port, targetId)` beside `probePort`; the shared page-type filter exported rather than duplicated. |
| [src/server/api-server.ts](../src/server/api-server.ts) | The `DELETE` route: ownership, guards, confirm-gone poll, mapping to 404/409. |
| [src/server/session-manager.ts](../src/server/session-manager.ts) | `sessionHoldingTarget(port, targetId)` for guard 4 and the §1 join; `SessionListItem.tab`. |
| [src/mcp/schemas.ts](../src/mcp/schemas.ts) | `closeCdpTabInput`/`Output`; `sessionId` on tab entries; `tab` on session entries. |
| [src/mcp/tools.ts](../src/mcp/tools.ts) | Register `close_cdp_tab`; gate; description; the §4 description sentences. |
| [src/mcp/api-client.ts](../src/mcp/api-client.ts) | `closeCdpTab` — id and targetId via `encodeURIComponent`. |
| [src/mcp/errors.ts](../src/mcp/errors.ts) | The §5 rows. |
| `usage.ts`, README, `server-start.ts` | Inventories (§3). |

## Tests

House pattern: no `supertest`, `listenOnRandomPort()`, and `tsconfig.json`
excludes `tests` so lint does not typecheck them.

### Route (real app over HTTP)

- Close an existing non-last tab → 200, echoes title/url, count reflects
  the observed post-close list; the poll is exercised with a target that
  disappears late.
- Unknown target → 404 carrying both readings; last tab without the flag →
  409 naming `allowBrowserExit`; last tab with it → 200 with
  `browserExited: true` once the (faked) endpoint stops answering, and the
  registry then reports the profile under `available`; tab held by a
  session → 409 naming the session, and succeeds after that session
  closes; unowned port → 404.
- **The count and the refusal use the listing's filter**: a browser whose
  only other target is an extension page still refuses the close as
  last-tab — the drift this shared helper exists to prevent.
- Auth required; idle monitor bumped.

### MCP seam (`InMemoryTransport`)

- `close_cdp_tab` end to end against a faked client; `structuredContent`
  complete; text summary names the closed tab's title.
- Exactly-one `profile`/`port` refusal; profile resolution skips the gate;
  raw `port` still gated; foreign refused naming `allowUnowned`.
- `list_cdp_browsers` maps `sessionId` through; `list_sessions` maps `tab`
  through, null for a fresh session.
- Existing inventory guards (`mcp-seam.test.ts` tool list, both
  `mcp-schema-dialect.test.ts` manifests) updated — they fail first
  otherwise, by design.

### Live (manual, required to merge)

**Run, and green: 37 checks against real Edge 151** through the real
Sessions API server over plain `fetch` (rule 9 by construction). Two scripts:
the tab lifecycle (27 checks — listing shape, the unknown-id refusal with
both readings, "close the openrouter tab" end to end with every other tab
verified untouched, the last-tab refusal and then the flagged close, the
profile landing in `available`, and a relaunch onto a **different** port),
and a session on a tab (10 checks — the tab→session join, the session-held
refusal naming `close_session`, a different tab in the same browser still
closing, and the same close succeeding after the session is closed).

Rule (7) is proved on the **streaming** path: with three tabs open, every
`step:*` event carried `tab.targetId` equal to the tab requested via
`config.cdp.tab: "targetId:<id>"`. The non-streaming response's `results[]`
has never carried a `tab` field, so checking there reports `null` and proves
nothing — a trap worth knowing before rerunning this.

## Found in implementation

Both of these were found by **using the feature to clean up after the live
test** — closing the test browser's tabs one at a time — rather than by any
unit test. Both are fixed, with a regression test each.

1. **`browserExited: false` on a browser that had exited.** A slow-closing
   tab finished during our own close, the browser dropped to zero tabs and
   went away, and the result still reported the browser as running — because
   `before.length > 1` was treated as proof that this was not the last tab.
   It describes one instant, and another client can empty the browser
   concurrently. Now: when nothing is left afterwards, the port is asked
   directly instead of the earlier count being trusted. The failure mattered
   because it is exactly the lie the `browserExited` field exists to prevent
   — an agent would have told the user their browser was still open while it
   was gone from the taskbar.
2. **The 2 s confirm budget was too tight.** A tab whose session had just
   been torn down took longer than that to leave `/json/list`, so a close
   that was working fine returned "state unknown, re-list before retrying".
   W0's 7–41 ms is the idle case, not the worst one. Raised to 5 s, with a
   separate, much shorter budget (1.5 s) for confirming a process exit —
   which W0 measured at 95–286 ms, and which would otherwise make every
   last-tab close feel broken.

## Found in adversarial review

An independent reviewer ran against the finished branch. Every item below was
reproduced by execution before being fixed; several were proved by mutating
the source and showing the suite stayed green.

**Defects that would have shipped:**

1. **`allow_browser_exit` was bypassable by two concurrent closes.** Both read
   a two-tab list, both concluded they were not closing the last tab, and the
   browser exited with neither caller having asked — an MCP host issuing two
   tool calls in one turn is enough. Fixed with a per-browser queue in the
   route (a *queue*, not the single-flight the launch path uses: two closes of
   two different tabs must both happen, just not at once).
2. **The confirm-gone poll could never succeed once the browser was
   unreachable.** The predicate required a readable tab list, so a browser that
   exited during the close burned the full budget and then told the agent the
   tab "was still open", blaming a `beforeunload` dialog — about a browser that
   no longer existed. It also made the zero-tabs-left branch unreachable in
   exactly the case it was added for.
3. **`list_cdp_browsers` hard-failed against a Sessions API server from an
   older build.** `sessionId` is required-and-nullable, and the handler passed
   the server's response through unnormalised — so a missing key degraded the
   whole listing to `isError` with nothing readable in it. Reachable without
   doing anything wrong: readiness checks verify the server's *identity*, not
   its version, so a server left running from a previous build is used happily.
   The first call of this story's own flow was dead. `list_sessions` already
   normalised its equivalent field; this one was missed.
4. **The session guard enumerated only the session's *active* browser.**
   `browserSession` is a snapshot and `openBrowser` auto-promotes, so a session
   that attached to a CDP tab and then opened a second browser reported the
   wrong browser's tabs — the tab it was really driving looked unheld, and the
   guard would have let it be yanked mid-run. Now walks `browserTracker.all()`.
5. **`mcp.cdp.allowUnowned` granted nothing for a close.** The MCP gate let a
   foreign port through and the registry then refused it one layer later, since
   ownership is proved from `knownProfiles`, which only ever holds this
   project's profiles. The refusal even recommended the setting. Now passed
   through to the server as `allowUnowned`, the same shape and reasoning as
   `includeForeignTabs` on the listing.
6. **A 404 from `/json/close` was absorbed as success**, handing back
   `closed: true` with a title and url for a tab something else had closed.
   `notFound` was computed and then unused.
7. **A resident browser with zero tabs was reported in silence** on the
   ordinary path — `remainingTabs: 0, browserExited: false, warnings: []` is a
   contradiction with nothing to act on. The last-tab branch already warned.

**Two test gaps, both proved by mutation.** The shared page filter was never
exercised through the close path — every close test injected `listTabs`, and
rewriting `listPageTabs` to skip `toPageTabs` entirely left 169 tests green.
That is the one test this story's own Tests section named as must-exist-first.
And the whole session-join half (`sessionsByTarget`, `resolvedTargetIds`,
`activeTabRef`) had no coverage at all: the route test mocks `closeCdpTab`
wholesale and the registry tests inject `sessionHolding` as a lambda, so the
guard was proven only against a fake of itself — which is exactly where defect
4 was hiding. Both now covered.

**Hardening on two unconfirmed risks the reviewer flagged honestly as
unproven:** `resolvedTargetIds` had no timeout while sitting on two HTTP paths
that have no deadline of their own, and a page whose first target-id lookup
failed stayed invisible forever, because re-awaiting a settled promise is not a
retry (now genuinely retried — the first fix for this was wrong and its test
caught it).

### Round two — attacking the fixes

A second reviewer ran against the fixes. Four held up; four did not, and two of
those were introduced *by* the first round.

1. **The poll fix over-reached and turned a flaky read into a false
   `closed: true`.** Making an unreadable tab list satisfy the predicate fixed
   the exited-browser case and broke a worse one: `listPageTabs` returns null
   for a single failed fetch or a 1.5 s abort, and the poll runs ~200 times
   against a tab showing a "Leave site?" dialog — so one bad read reported the
   tab as closed while the function's own final read could still see it. Now
   asks the port which of the two it is.
2. **The `resolvedTargetIds` timeout failed the guard OPEN.** It bounded the
   whole sweep and returned `[]` on expiry, so one slow lookup made a session's
   tabs invisible and a tab it was mid-run on became closable — the exact
   outcome the guard exists to prevent, reintroduced by the fix for a hang.
   Worse, the comment and this story both claimed it returned partial results,
   which it could not: a `Promise.all` has none. The budget is now **per page**
   so the partial answer is real, and the sweep reports `complete`, which the
   close guard treats as a refusal. *For a guard, "I could not find out" must
   never read as "nobody is holding it."*
3. **The unowned-browser stub leaked into advice that is false for someone
   else's browser.** The last-tab refusal told the agent the profile keeps its
   logins and `start_cdp_browser` brings it back — untrue of a foreign browser,
   and it is the sentence that decides whether the agent asks before
   terminating a human's signed-in Chrome. Both that message and the tool
   summary now branch on a new `owned` field.
4. **The close queue was keyed on `(projectRoot, port)`**, but a port is one
   socket on the machine and identifies the browser by itself; `projectRoot`
   does not. One browser therefore got a queue per project, and this server is
   a per-machine singleton — so the concurrency guarantee evaporated exactly
   where `allowUnowned` makes two projects able to address one browser. Keyed
   on the port alone.

**Confirmed correct and left alone:** the queue mechanics themselves (attacked
with a five-deep burst including rejections — strict FIFO, no dropped link, no
leak), the `allowUnowned` privilege boundary, the 404-is-not-success change,
and — the reviewer's own biggest suspicion — the inverse of defect 4 above:
a session holding both a CDP and a launch-mode browser does contribute the
launch-mode browser's ids to the port's join, but those entries are inert,
since the guard only ever looks up an id the port's own tab list already
produced.

One test bug of my own surfaced here too: the timeout sentinel is a symbol, and
the id filter tested `!== null`, so the sentinel leaked into the id list. The
test written for the fix caught it before it shipped.

### Round three — attacking round two's fixes

Run because rounds one and two had each introduced defects. It found three
more, one of them the worst version-skew case in the feature.

1. **A successful, irreversible close was reported to the agent as a broken
   tool.** Round two added `owned` as a required output field and skipped the
   normalisation its own neighbour already does — so against a Sessions API
   server predating it, validation fails *after* the tab has been closed. The
   agent is told the tool is broken with no structured content, retries, and
   gets "something else closed it first". The user hears the close failed
   twice, about a tab that is gone. Reachable without doing anything wrong:
   readiness checks compare identity, never version, and the server is a
   per-machine singleton. `owned` is now backfilled `true` — a server without
   the field has no unowned path at all.
2. **The tool's static prose still made the promise round two removed
   everywhere else.** The description and `allow_browser_exit`'s own
   description still said *"Nothing is lost: the profile keeps its logins…"*.
   Round two fixed the runtime refusal and the summary and missed the two
   places that are in the model's context at *every* call — and which are what
   an agent reads when it sets the flag pre-emptively, the path where the
   corrected refusal never fires. Both now qualify the reassurance by
   ownership, and the description no longer claims the tool only touches
   browsers this project launched.
3. **The new refusal recommended a call that hangs under the same
   condition.** It pointed at `list_sessions` to find the busy session — but
   `activeTabRef` awaited the same unbounded lookup, so the listing stalls
   exactly when the refusal fires. `activeTabRef` is now bounded like the
   sweep, and the remedy no longer sends the caller somewhere that cannot
   answer.

**Also closed:** `sessionsByTarget` had no tests — both ends of the guard chain
were covered and the middle link was not, which is where the browser-tracker
defect hid through two rounds. And the join compared `cdp.port` strictly while
`POST /sessions` casts `body.config` unvalidated, so a hand-rolled client
sending a string port got a working CDP session invisible to the guard; the
comparison now coerces, because this guard failing open is the expensive
direction.

### Round four — convergence

The first round to introduce **no new defect**. What it found instead was three
*incomplete* fixes, which is a different and more encouraging failure mode:

1. **The `owned` backfill was a lie in the dangerous direction, and the comment
   justifying it was provably false.** Round three defaulted a missing `owned`
   to `true` on the reasoning that "a server without this field has no unowned
   path at all". Not true for exactly one commit — the one that added
   `allowUnowned` before `owned` existed — so a mid-branch server can close a
   browser this project did not start *and* omit the field. The agent would
   then be handed `owned: true` for a human's just-terminated browser, plus the
   "profile keeps its logins" reassurance about something nothing here can
   reopen. Now **derived** from what the tool knows locally: a profile-resolved
   port is owned by construction, and with `allowUnowned` off the gate already
   proved the port is in `running`. Anything else is unknown, and unknown
   resolves to `false` — the cautious message. `warnings` got the same
   treatment, being the other required field read un-normalised on the
   after-the-tab-is-gone path.
2. **The README still carried the unqualified promise.** Round three fixed
   three of the four places and missed the one a human reads, sitting directly
   after the paragraph explaining the `allowUnowned` gate.
3. **The `activeTabRef` bound did not achieve its stated purpose.** It was
   added so `list_sessions` could answer when a close is refused for a slow
   session — but `page.title()`, seven lines above it in the same loop, is
   equally unbounded, so any non-MCP caller still hung forever; and the loop was
   sequential, so per-session budgets *summed* and three sessions on one wedged
   browser took 6 s against `list_sessions`'s own 5 s abort. The listing now
   fans out, and both page reads are bounded — so the cost is the slowest
   session rather than their total. The refusal also points at `list_sessions`
   again, which is now safe to recommend.

**Confirmed correct on the round-three pass:** the poll predicate in both directions
(with no extra HTTP on the happy path), the whole `complete` chain — no
spurious refusals reachable, no symbol leaking to the wire, the listing
unaffected — `owned` at all four return sites, the port-keyed queue (cross-
project blocking is bounded by the existing timeouts, not indefinite), and
`isBrowserDialog` against real Chrome in both directions: `chrome://settings`
survives query and fragment canonicalisation, and WebUI bubbles report
`type: 'browser_ui'` so they never reach the heuristic.

**A browser dialog is a `page` target but not a tab — and it defeated the
last-tab guard.** Found in live testing *after* review, by re-running the
suite: Edge reports `edge://sync-confirmation-dialog/` as `type: 'page'`, so
a browser with one real tab listed two, the guard concluded it was not
closing the last one, and the browser exited with nobody having passed
`allow_browser_exit`. That is precisely the failure the guard exists to
prevent, and no amount of unit testing would have produced the dialog. The
shared filter now drops `*-dialog` surfaces on the internal schemes.

The asymmetry there is deliberate: only `*-dialog` is dropped, not internal
pages generally, because `edge://settings` and `chrome://history` are real
tabs a user opened. **Over-counting risks killing a browser; under-counting
only produces an unnecessary refusal** — so the heuristic is tuned to fail in
the second direction. The same finding retired one wording: the tool summary
said *"that was its last tab, so … closed too"*, which the tab count is not
entitled to claim once counting and the browser's own idea of what keeps it
alive can disagree. It now says the browser closed, without saying why.

**Two smaller things worth recording.** `chrome://newtab` is an ordinary
closable `page` target and is deliberately *kept* by the shared filter:
excluding it would make the last-tab guard fire one tab early, reporting a
browser as empty while a real tab was still open. And the non-streaming
`POST /sessions/:id/steps` response has never carried the per-step `tab`
field — it lives on the SSE stream, which is what the MCP client folds — so
rule (7) is proved against the streaming path.

## Risks / open

- **The confirm-gone poll adds latency to every close** (tens of ms
  typically, bounded at 5 s). Accepted: a fast lie is worse than a slow
  fact, and live testing showed the slow case is real.
- **`sessionId` on the tab list is only as fresh as the probe.** A session
  created after the list was taken is caught by the close-time guard, not
  the listing — the listing is advisory, the guard is authoritative.
- **Two browsers, same profile name, different engines** — inherited
  ambiguity, same answer as [cdp-session-binding.md](cdp-session-binding.md):
  refuse and name both unless `engine` disambiguates.
- **"The last tab closes the process" is a Windows/Linux default, not a
  law.** macOS keeps an app alive with zero windows, and Edge on Windows has
  Startup Boost / background modes that could keep a resident process. W0
  saw a clean exit on both engines *here*, which is why the resident case is
  reported honestly (`browserExited: false` plus a warning) rather than
  assumed away — it is the branch this machine cannot exercise.
- **An incognito window is the one "window" that behaves like another
  browser** — its own cookie jar in the same process, on the same port. W0
  confirms its tabs **do** appear in `/json/list` and **do** close, so this
  story works on them. The other half does not: attach resolves `cdp.tab`
  against the default context's pages only
  ([manager.ts:1163](../src/browser/manager.ts:1163)), so
  `tab: "targetId:<incognito>"` cannot resolve and a session cannot be bound
  to one. Closing works, selecting does not — a pre-existing asymmetry this
  story surfaces rather than introduces, and a candidate for its own change.

# Plan

## Workstream graph

```
W0 verify /json/close (Chrome + Edge) ──> W1 server: closeTab + route + guards + sessionId join
                                              └──> W2 MCP: close_cdp_tab + errors + inventories
W3 visibility: list_sessions.tab + descriptions   (independent of W0–W2)
```

## Workstreams

**W0 — the mechanism check.** Script, not framework code: launch each
engine via the existing registry, open three tabs, `/json/close` one,
observe `/json/list` until it disappears; then close down to the last tab
and observe the process — does it exit, how fast, does the port die
cleanly, and does Edge's Startup Boost keep a resident process. Also list
and close an incognito tab (§Risks). The story's assumptions in §2 either
hold or the fallback is chosen — before W1 starts.

**W1 — server.** §1's join, §2's route and guards. The shared-filter test
first: it is the one that fails silently in production and loudly nowhere
else.

**W2 — MCP tool.** §3, §5. The refusal texts are the point, not an extra —
each carries its next action.

**W3 — visibility and prose.** §4. Ships independently and first if
convenient; it is the cheapest fix to the measured attach-got-a-new-tab
trap.

## Repo gotchas

- **Rebuild `dist/` and restart the Sessions API server** before testing by
  hand — the MCP server the host (e.g. Claude Code) spawns runs `dist/`,
  and the route lives in the separately-running server process. No
  TestBench extension bump: this is all server-side.
- **Output schemas are SDK-validated** — every new field `.nullable()`,
  never optional.
- **The full vitest run is intermittently flaky** (worker-pool crash, all
  files at once, ~8 s, 0 tests). Re-run the single file before believing a
  regression.
