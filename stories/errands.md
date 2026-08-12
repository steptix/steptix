# Errands — borrow a tab, drive it, hand it back

> **Verification rule for this story.** "Done" means: (1) with a CDP browser
> holding a signed-in tab that NO session has ever touched, `run_errand`
> naming that tab by title drives real steps in it and returns a receipt —
> `list_sessions` afterwards shows **no new session**, and yet while the
> errand runs the server counts it as a run in flight: `POST
> /admin/shutdown` without `force` refuses, and the idle reaper cannot fire
> ([server-lifecycle](server-lifecycle.md) — "idle" means no run in flight,
> and an errand IS a run); (2) while a session is attached to that same tab
> but idle, the same errand still works, and the session's next `run_steps`
> afterwards still works (the two-client coexistence this story measured on
> 2026-08-12, re-proved through the real tool rather than a raw socket);
> (3) an errand arriving while ANOTHER errand is driving **or opened**
> that tab is refused with a message naming the holding `errandId` and
> offering wait-and-retry (there is no `close_errand`), and succeeds on
> retry once the holder finishes; an errand arriving while a session is
> mid-batch on that tab is refused naming the session id; a `run_steps`
> batch arriving while an errand drives that tab proceeds — sessions take
> no lock (the [mcp-cdp-browser](mcp-cdp-browser.md) §Locked decision,
> "no per-port serialisation and no tab-collision guard" *for runs*,
> stands: nothing here serialises or refuses session work); and
> `close_cdp_tab` aimed at a tab an errand is driving or opened is
> refused naming that `errandId`, and succeeds once the errand finishes;
> (4) the receipt carries the `errandId`, the root the errand resolved
> against and its `scope` ([mcp-no-project](mcp-no-project.md) §Locked —
> every result says which root it used), the per-step outcomes, every
> `store as` capture, the tab's final `url` and `title`, the list of tabs
> the errand opened, and the `effectiveSettings` it ran under — and
> nothing of the errand survives on the server, checked three bounded
> ways: `list_sessions` returns the same set before and after, the
> project's report directory gains no file, and a second errand
> interpolating a variable the first errand captured leaves it
> unresolved — the step text reaching the executor still carries the
> literal `{{x}}` (observed at the executor seam; the receipt's per-step
> `text` echoes the *sent* step, so it cannot discriminate) and the
> second receipt's `captures` carry no such name; the errand does not
> error, exactly as `run_steps` would not;
> (5) a tab the errand did not open is never closed by it; a tab or
> browser it DID open during its steps is gone by the time it returns —
> or, for tabs with `keep_open: true`, still open and named in the receipt
> — and the detach path REQUESTS activation of the borrowed tab, asserted
> at the mocked Playwright seam; whether it visibly came forward is
> confirmed by a human in the live pass, because no assertion in this repo
> can see a screen ([cdp-tab-focus](cdp-tab-focus.md)'s own rule); (6)
> `run_errand` passing `session_id` is refused before any browser work
> with an `isError` result naming `run_steps` as the door for sessions,
> and `run_steps` passing `config.cdp` onto an existing session now ends
> its warning with a pointer to `run_errand`; (7) an errand naming a tab
> that matches nothing is refused with the browser's open tabs listed, so
> the caller can re-name one from what is actually open; one that matches
> two is refused naming both candidates; and the candidate set is only
> ever the filtered listing — an `iframe`, `browser_ui` or `*-dialog`
> target is never a candidate, however well it matches; (8) a live routing
> probe (both tools offered to a real model, a matrix of phrasings from
> "run my login test" to "go export the report on my OpenRouter tab") is
> run per supported host model and its table recorded here, misses
> reported as product findings, never asserted as test failures. A vitest
> suite drives (1)-(7) through a real in-memory MCP client against the
> real API server; (2), the human half of (5), and (8) additionally run
> live.

## Context

The framework has one way to drive a browser: a **session**. A session was
designed for running and debugging a test file, and it behaves like the
owner of everything it touches: it opens a browser, keeps every tab and
variable and video for the whole run, and closes the lot when the session
closes. For tests that is exactly right.

Then users started asking for something else: *"go click the export button
on that OpenRouter tab I have open."* Not a test. No file, no report, no
variables worth keeping. Just: borrow my tab for a moment and drive it.

Forcing that request through the session concept fails in a specific,
measured way. A session's browser is chosen **once**, when the session is
created, and never revisited ([src/server/session-manager.ts:1289](../src/server/session-manager.ts:1289)
is `createSession`'s only call site — inside the miss-arm of a lookup by
session name). The MCP tools default every `run_steps` call to the **same**
session name (`mcp:steps-<pid>-<projecthash>`,
[src/mcp/tools.ts:235](../src/mcp/tools.ts:235)), so the first `run_steps`
of a server's life decides the browser for every later call. Measured live
on 2026-08-12: the only session on the project server was
`mcp:steps-9268-83ea9b2d`, sitting on `about:blank` in a plain launched
browser, while the user asked — repeatedly, via an agent — for work on a
CDP tab named "Activity | OpenRouter". Every request found the session
alive, reused it, and the named tab never reached the attach code. The
warning added by [cdp-session-binding](cdp-session-binding.md)
([src/mcp/tools.ts:509](../src/mcp/tools.ts:509)) correctly reported that
`config.cdp` was ignored — but a warning is a bandage on a concept asked to
do a job it wasn't designed for.

The fix is not a better session. It is a second concept with the ownership
turned around: the **errand**. In a session, the framework owns the browser
and the user is a spectator. In an errand, the **user owns the tab** and the
framework is a guest — it borrows the tab, does the job, hands back
everything it learned, and leaves nothing of itself behind.

|                          | Session (test run)             | Errand                                  |
| ------------------------ | ------------------------------ | --------------------------------------- |
| Who owns the browser     | The framework — it opened it   | The user — it is their tab              |
| Lifetime                 | Until closed; state persists   | One request; nothing persists           |
| How the browser is found | Once, at creation, then frozen | Re-found fresh on every errand, by name |
| Variables captured       | Kept in session scope          | Returned in the response                |
| On finish                | Close everything it opened     | Close nothing it didn't open            |

The third row is the load-bearing one: the stale-session failure above is
not *fixed* by errands, it is made **impossible** — an errand has no past to
go stale in.

Two sibling stories frame this one. [cdp-session-binding](cdp-session-binding.md)
makes the session world say honestly which browser it bound and when a
request's CDP config was dropped. [cdp-tab-focus](cdp-tab-focus.md) lets an
agent bring a tab forward for the user to watch. Errands complete the set:
the user can finally say *"now drive it."*

## The concept, precisely

An errand is: **attach → act → return → detach**, in one request.

- **Attach.** Resolve the tab fresh, every time, in two stages, both
  MCP-side the way `close_cdp_tab`/`focus_cdp_tab` resolve
  (`resolveCdpTarget` against the server's browser listing,
  [src/mcp/cdp.ts:135](../src/mcp/cdp.ts:135), the registry behind `GET
  /cdp/browsers`). First the browser: profile + engine + scope, a name
  live under two engines or under both roots refused naming both
  (`cdpProfileAmbiguous` and kin, reused as-is), never a silent pick.
  Second the tab: match the `tab` argument against the resolved browser's
  tab list **as the listing reports it** — the same page-type-filtered
  view `list_cdp_browsers` shows (`toPageTabs`,
  [src/browser/cdp-discovery.ts:137](../src/browser/cdp-discovery.ts:137)),
  so an errand can only borrow a tab the listing would show. Exactly one
  match proceeds; several refuse, naming every matching candidate
  (`title` + `url` + `targetId` each); zero refuse the same way over the
  browser's whole tab list, so the caller can re-name one from what is
  actually open. The winner's `targetId` is what the request carries to
  the server, and the existing attach path (`connectOverCDP` +
  `resolveCdpTab` with a `targetId:` spec,
  [src/browser/manager.ts:1344](../src/browser/manager.ts:1344)) is
  handed only that exact spec — the first-match-wins arm of
  `resolveCdpTab` is never asked to arbitrate. Nothing about a previous
  errand's resolution is remembered or reused.
- **Act.** Run the steps with the same executor, action vocabulary and AI
  resolution sessions use. A step neither knows nor cares whether a
  session or an errand is running it. `[skill: …]` and `[tool: …]` are the
  exception, refused by name — the same `[skill:`/`[tool:` token rule
  `run_steps` already refuses in user scope
  ([src/mcp/assemble.ts:63](../src/mcp/assemble.ts:63)) — because an
  errand deliberately carries no `skillsDir`/`toolsDir`. Section calls
  need no refusal: they resolve only through the `sections` map a parsed
  test file supplies ([src/mcp/types.ts:159](../src/mcp/types.ts:159)),
  which a fileless request never carries, so a bare section-name line is
  already just prose. The errand DOES carry a synthetic `testFilePath`
  (`<project_root>/.aiui-errand.md`, the same device `run_steps` already
  uses, [src/mcp/assemble.ts:332](../src/mcp/assemble.ts:332)) and an
  optional `env_name` — that path is the only thing the server resolves a
  project root from
  ([src/server/session-manager.ts:1029](../src/server/session-manager.ts:1029)),
  and without it the project layer of `effectiveSettings` would silently
  fall back to server defaults. `${env.X}` resolves from the project's
  environment **only when `env_name` names one**: with no `env_name` the
  server builds no env bundle (`if (envName)`,
  [src/server/session-manager.ts:1070](../src/server/session-manager.ts:1070))
  and the placeholder reaches the AI as literal text — there is no
  default-env concept — so `run_errand` emits the same
  pass-`env_name`-to-resolve warning `run_steps` already does
  ([src/mcp/assemble.ts:720](../src/mcp/assemble.ts:720)).
  `{{placeholders}}` resolve only from the errand's own earlier `store
  as` captures.
- **Return.** The response is a receipt: an `errandId` the server mints
  per request (alive only while the errand runs — see item (4)), the root
  the errand resolved against and its `scope`
  ([mcp-no-project](mcp-no-project.md) §Locked: every result says which
  root it used — an errand's whole project layer hangs off that
  resolution), per-step outcomes, every `store as` capture (this is where variables go — to the
  caller, who is the brain here; the server keeps no scope), the final
  `url` and `title` of the borrowed tab, a list of anything the errand
  opened along the way, and the `effectiveSettings` it ran under — an
  errand has no session to hold overrides, so the chain is server base →
  project bundle, and the receipt echoes it
  ([run-settings](run-settings.md): every run result names the settings
  it ran under). Transport is the shape that already exists: the errand
  route emits the same `RunEvent` stream `POST /sessions/:id/steps?stream=1`
  does, `effectiveSettings` rides the `done` frame, and the MCP side
  builds the receipt with the same fold that already turns events into
  `steps[]` + `captures{}` ([src/mcp/run-fold.ts](../src/mcp/run-fold.ts)).
- **Detach.** Disconnect from the browser without disturbing it. Close
  tabs — and any browsers a step opened — that the errand created; never
  the borrowed tab or any other pre-existing one. Request activation of
  the borrowed tab on the way out — hand back the keys visibly. "Request"
  is the honest verb: the DevTools surface has no read of "is this tab
  frontmost", and on Windows the OS may decline a raise from a background
  process
  ([src/browser/cdp-discovery.ts:228](../src/browser/cdp-discovery.ts:228)) —
  so the raise is silent and non-fatal, the same posture as
  [cdp-tab-focus](cdp-tab-focus.md).

### The wheel: one driver at a time

A tab has one steering wheel. Concurrent CDP *clients* on one tab are fine —
measured 2026-08-12 against a live "Activity | OpenRouter" tab: two
simultaneous flattened `Target.attachToTarget` clients on the browser
endpoint (the exact mechanism two Playwright `connectOverCDP` connections
use) both evaluated in the page, one detached, the survivor was unaffected.
Concurrent *drivers* are not fine: interleaved input, both clients handling
the same dialog, and page-global emulation overrides are all
simultaneity hazards.

So the server keeps a per-tab (targetId-keyed) turn lock — **taken by
errands only**:

- An errand holds the lock on **every tab it is tracking — the borrowed
  tab plus any it opened** — for its lifetime, mirroring
  [cdp-tabs](cdp-tabs.md) §Locked's "all of a session's tracked pages"
  and for the same reason: steps can switch back to a tab they opened.
  Release is not a step anyone can forget — finishing *is* releasing,
  including finishing by error.
- A second errand on any tab of that set is refused with the holding
  `errandId` named and told to wait and retry — there is no
  `close_errand`, and it does not queue silently.
- Before taking the lock, an errand also consults the session manager's
  own tab tracking — the same join `close_cdp_tab`'s guard already does
  ([src/server/session-manager.ts:1697](../src/server/session-manager.ts:1697)),
  **extended to carry each holder's status**. The extension is not
  optional: the join today returns `targetId → sessionId` with no status
  and keeps only the first holder per target
  ([src/server/session-manager.ts:1723](../src/server/session-manager.ts:1723)),
  so filtering its output would let an idle winner mask a mid-batch
  session. A session with a batch in flight (`status === 'executing'`) on
  that tab refuses the errand, naming the session id. An idle session
  blocks nothing — idle is the safe case, mid-run is the dangerous one.
  A join that could not be completed does not block either: unlike a
  close — where the guard refuses on a maybe because its failure closes a
  tab under a live run — a borrow that guesses wrong is bounded by one
  request and shows up in both sides' receipts.
- **Sessions never take and are never blocked by this lock.** That is not
  an oversight: [mcp-cdp-browser](mcp-cdp-browser.md) §Locked rejected
  per-port serialisation and tab-collision guards *for runs*, and that
  decision stands — nothing here serialises or refuses session work. A
  `run_steps` batch arriving while an errand drives the tab proceeds; the
  hazard is bounded by one errand request and both sides' receipts make
  what happened explainable.
- `close_cdp_tab`'s hold guard consults the errand lock the same way it
  consults sessions: a tab an errand is driving or opened refuses the
  close, naming the `errandId` and offering wait-and-retry. **This is a named amendment
  to [cdp-tabs](cdp-tabs.md) §1, §2 and §5** — §2 gains the errand check
  as a numbered step beside the session refusal (before the last-tab
  gate, for the same remedy-quality reason cdp-tabs ordered 3 before 4,
  and inside the same port-keyed close queue); §5's error table gains the
  row (condition: errand-held tab; message names: the `errandId` and its
  tab; next action: wait for the errand to finish, then retry); and §1's
  "null for a tab nothing is driving" gains a stated exception rather
  than a silent one: an errand's hold is NOT in the listing, because it
  lasts one request — a listing entry would be stale by the time an agent
  acted on it, and the refusal, which offers a retry that works moments
  later, is authoritative. `focus_cdp_tab` is unaffected — it has no
  guard by design.

The lock cannot cover the human. The user is always the implicit senior
driver, and no lock stops them typing into the tab mid-errand. The receipt
is the mitigation: it reports what the errand actually did, so a surprising
page state is explainable rather than mysterious.

### House rules (enforced in the detach path, not promised in prose)

1. Never close, navigate-away, or sign out a tab the errand did not open.
   Navigation *as a requested step* is allowed — the receipt records where
   the page ended up.
2. Tabs and browsers opened during the errand are the errand's coat: taken
   when leaving. `keep_open: true` spares **tabs** — they stay and the
   receipt names them; it never spares a browser a step opened, which is
   closed regardless (the teardown rule
   [multi-browser](multi-browser.md) already sets for runs). Closing
   errand-opened tabs at all is new code: today nothing closes tabs opened
   mid-run on a CDP browser — `closeBrowser` only handles the tab the
   attach itself opened.
3. End by requesting activation of the borrowed tab — the same silent,
   non-fatal `bringToFront` courtesy the attach path already extends at
   [src/browser/manager.ts:1390](../src/browser/manager.ts:1390).
4. The pre-existing-pages guard ([src/browser/manager.ts:1363](../src/browser/manager.ts:1363),
   enforced through `PageTracker`) is the errand's whole personality:
   everything it protects for CDP sessions, an errand applies to every page
   but its own.

## Tool surface

```
run_errand {
  tab:          string          # required. targetId:<id> (preferred, exact), title~<substring>,
                                # url~<substring>, or a bare string — matched case-insensitively
                                # as a substring of the tab's title and of its url (the union is
                                # the candidate set). String.includes semantics: no globs, no
                                # regex. Resolved fresh, over the filtered live tab list;
                                # zero or several matches refuse (§Attach).
  profile?:     string          # CDP profile name, default "default"; an explicit "" is
                                # normalised to the default before resolution (a deliberate
                                # divergence from close_cdp_tab's no-default optional —
                                # run_errand has no port, so the per-tool no-address
                                # refusal family is unreachable and must stay that way)
  engine?:      'chrome'|'edge' # disambiguates profile, as on close_cdp_tab/focus_cdp_tab
  scope?:       'project'|'user'
  project_root?: string         # as on every other tool
  env_name?:    string          # as on run_steps; without it no env bundle is built and
                                # ${env.X} passes through as literal text (§Act)
  steps:        string[]        # step language as run_steps, minus [skill:]/[tool:] (§Act)
  keep_open?:   boolean         # leave errand-opened tabs behind (default false)
  session_id?:  string          # DECLARED ONLY TO BE REFUSED — the description says
                                # "errands have no sessions — use run_steps"; the handler
                                # refuses any call carrying it before any browser work
}
```

**Browser** addressing is the same profile + engine + scope triple as
`close_cdp_tab`/`focus_cdp_tab`, port never required; the ambiguity
refusals (`cdpProfileAmbiguous` and kin) are reused as-is. The **tab**
slot is different on purpose, and that difference is a **named amendment
to [cdp-tabs](cdp-tabs.md) §Locked and [cdp-tab-focus](cdp-tab-focus.md)
§Locked** ("the agent matches; the tool takes an exact `targetId`"):
`run_errand` accepts a name because the parameter funnel is a routing
mechanism (§Routing 3), and because zero-or-several *refuses naming
candidates* rather than the first-match-wins those stories were guarding
against. The destructive verb — `close_cdp_tab` — keeps exact-only.

Deliberately absent: `config` (no baseUrl/timeout bundle; an errand
inherits the project's), report-path plumbing (the receipt IS the report —
no file is written, full stop), `parameters` (steps are literal; the
caller inlines values), and the five run-settings overrides `run_steps`
carries (`model`, `capture`, `full_page`, `send_screenshots`,
`screenshots_return`) — an errand has no session to hold overrides, so
the project/server chain decides; the one client-side member,
`screenshots_return`, folds with its shipped default
(`DEFAULT_SCREENSHOTS_RETURN`, `'on-failure'`).

`session_id` is **declared but always refused**: the schema lists it only
so its description can say "errands have no sessions — use run_steps", and
the handler refuses any call carrying it before any browser work, with the
repo's standard pre-flight `isError` result naming `run_steps`
([src/mcp/errors.ts](../src/mcp/errors.ts) — pre-flight failures are
returned, not thrown; a bare Zod schema would silently strip an undeclared
key, which is the wrong-door silence this story exists to kill, and an SDK
schema throw carries only generic text no model learns from).

`run_steps` changes in two places, neither behavioural: its ignored-CDP
warning gains the ending *"…or use run_errand if you just want to drive
that tab"*, and the shared `CDP_NOTE` in both run tools' descriptions
([src/mcp/tools.ts:788](../src/mcp/tools.ts:788), shared with
`run_test_file` — the added sentence is phrased to be true of both) gains
the whose-browser decision rule from §Routing. Session *behaviour* is
untouched: no new refusal, no lock, no queueing change.

## Routing: how a model picks the right door

Measured lessons from the fleet console apply verbatim here: a tool
description is read only after the model is already considering the tool; a
global instruction is obeyed by strong models and skimmed by fast ones; the
only reliable layers are the ones built into the surface itself. Four, in
increasing order of trustworthiness:

1. **One-question decision rule**, stated in both tools' descriptions:
   *whose browser?* Ours to open → `run_steps`. Theirs to borrow ("my tab",
   "the one I have open", "my signed-in browser") → `run_errand`. Ownership
   words, not the word "test", are the signal — "test the checkout on my
   open tab" is an errand.
2. **The name.** `run_errand` (or `drive_tab`) echoes the user's own words
   at the moment of choice. Necessary, measured insufficient on its own.
3. **Parameter funnel.** The tab slot exists only on the errand. A model
   holding a tab name has nowhere else to put it.
4. **Wrong doors redirect.** Both tools answer a misrouted call with one
   self-correcting sentence: on `run_steps`, the ignored-CDP warning's
   new ending pointing at `run_errand`; on `run_errand`, the
   handler-level `session_id` refusal naming `run_steps`. This is the
   layer that rescues small models, because it converts a wrong pick into
   one extra round-trip.

Per the verification rule, routing is *probed live and reported*, never
asserted: a miss is a product finding about a model, and the record of it
belongs in this story the way the fleet console's spec records its own
misses.

## What already exists vs what is new

Reused unchanged: CDP discovery and profile addressing, including the
ambiguity refusals ([src/browser/cdp-registry.ts](../src/browser/cdp-registry.ts),
[src/mcp/cdp.ts](../src/mcp/cdp.ts)); the filtered tab lists over the
DevTools HTTP surface ([src/browser/cdp-discovery.ts](../src/browser/cdp-discovery.ts));
the attach path (`connectOverCDP` at
[src/browser/manager.ts:1344](../src/browser/manager.ts:1344), then
`resolveCdpTab` — [src/browser/manager.ts:985](../src/browser/manager.ts:985) —
handed only an exact `targetId:` spec); the pre-existing-pages guard
([src/browser/manager.ts:1363](../src/browser/manager.ts:1363)) and
disconnect-not-kill semantics (`closeBrowser`,
[src/browser/manager.ts:1457](../src/browser/manager.ts:1457)); the step
executor and AI resolution
([src/runner/step-executor.ts:266](../src/runner/step-executor.ts:266) —
it takes a page plus a context bag, not a session); and the run fold that
already turns run events into `steps[]` + `captures{}`
([src/mcp/run-fold.ts](../src/mcp/run-fold.ts)) — the receipt is that fold,
not the HTML report path.

New: the `run_errand` tool and schema; a `POST /errands` route on the API
server, emitting the same `RunEvent` stream the steps route does, and a
matching `ApiClient` method — required, not stylistic: the MCP process is
deliberately browser-free (its import graph is pinned by
`tests/mcp-entry-graph.test.ts`), so the runner must live server-side; an
`ErrandRunner` beside — not inside — `SessionManager` (it never **adds to**
the sessions map, which is what makes verification item (1) checkable — it
does read the tab-tracking join), sharing `SessionManager`'s in-flight run
counter for its lifetime so `/health`, the `POST /admin/shutdown` 409 and
the idle reaper all treat a running errand as the run it is
([server-lifecycle](server-lifecycle.md)); the per-request `errandId`; the
errand's two-stage tab matcher with its zero-or-several refusal; the
status-carrying extension of the tab-tracking join; the per-tab turn lock
(errand-held only) and the `close_cdp_tab` guard row; the detach path that
closes errand-opened tabs and browsers; the receipt shape.

And the inventory, which every tool story owes
([cdp-tab-focus](cdp-tab-focus.md) §5's standing rule): increment every
tool-count sentence in `mcp-server.md` — §2's "Thirteen tools" (word) and
"all 13 schemas" (numeral), §Tests' "**13** tools" (numeral), and the
by-name enumeration's own "the six added since" → seven, gaining
`run_errand`; add it to `usage.ts` and the README tool table; auto-start
needs no change — reaching the server through `withProject` gives it the
ON default ([src/mcp/tools.ts:669](../src/mcp/tools.ts:669)), and no tool
passes `autoStart: false` (cdp-tab-focus §5's "auto-start list" sentence
describes a list `server-start.ts` does not have — corrected there in
this story's PR); and add it to the `mcp-seam.test.ts`,
`mcp-schema-dialect.test.ts` (both manifests) and
`mcp-content-blocks.test.ts` `argumentsFor()` inventories.

## Build order

1. **Tool + runner.** Route, client method, tool, matcher, receipt,
   in-flight counting. Attach-fresh-every-time alone dissolves the
   measured stale-session failure. No lock yet; collisions are possible
   but were always possible.
2. **The wheel.** Errand-held per-tab lock, both refusal messages (errand
   holds it / session mid-batch on it), the status-carrying join
   extension, the `close_cdp_tab` guard row and the cdp-tabs amendments.
3. **Receipt polish + routing probe.** Capture forwarding, opened-tabs
   and opened-browsers accounting, `keep_open`, `effectiveSettings` echo,
   the live probe matrix per host model, results recorded here.

## Open questions

- **Leave-where-found.** Should an errand offer `restore_url: true` to
  navigate the tab back to where it started? Default no — the receipt
  reports the final location — but a borrowing mid-someone's-work case may
  want it.
- **Naming.** `run_errand` vs `drive_tab`. The probe (verification item 8)
  should test both spellings before the name freezes.
- **Scope search on a miss.** Ambiguity is settled — a profile name live
  under both roots refuses naming both (§Attach). Still open: when the
  named profile simply isn't running in the requested scope but is in the
  other, should the refusal add a "did you mean the user-scope one?" hint?
  A UX decision the first live use should settle.
- **`config.cdp.tab` on `run_steps`.** The vestigial tab slot on the
  session door predates errands. Deprecating it would complete the funnel;
  cdp-session-binding's warnings make it survivable meanwhile.
