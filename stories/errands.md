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
> offering wait-and-retry (there is no `close_errand`); once the holder
> finishes, a retry on the BORROWED tab succeeds, while a retry on a tab
> the holder itself had opened meets the zero-match refusal — the tab is
> normally gone with its errand, and the original refusal said which kind
> of hold it was; an errand arriving while a session is mid-batch on that
> tab is refused naming the session id; a `run_steps` batch arriving
> while an errand drives that tab proceeds — sessions take no lock
> (nothing here serialises or refuses session work; the errand-only
> guard is a **named amendment** to
> [mcp-cdp-browser](mcp-cdp-browser.md) §Locked's "no per-port
> serialisation and no tab-collision guard", whose subject — parallel
> sessions — is untouched); and `close_cdp_tab` aimed at a tab an errand
> is driving or opened is refused naming that `errandId`, and once the
> errand finishes the close succeeds for the borrowed tab (an
> errand-opened tab is by then already gone under the default
> `keep_open: false`, and the refusal's message says so);
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
> or, for tabs with `keep_open: true` in the borrowed browser, still open
> and named in the receipt — `keep_open` spares tabs, not browsers, so a
> tab inside a browser a step opened goes with it; and `keep_open` is not
> the only way one survives: `keptOpen` is every errand-opened tab still
> open on return, so a tab another errand took the wheel of, one whose
> close threw, or one in a browser still connected after its close was
> asked for, is named there too rather than claimed closed; and the
> detach path REQUESTS activation of the borrowed tab, asserted at the
> mocked Playwright seam; whether it visibly came
> forward is confirmed by a human in the live pass, because no assertion
> in this repo can see a screen
> ([cdp-tab-focus](cdp-tab-focus.md)'s own rule); (6)
> `run_errand` passing a NON-EMPTY `session_id` is refused before any
> browser work with an `isError` result naming `run_steps` as the door
> for sessions — an empty or whitespace `session_id` is treated as
> absent, because some provider layers serialize every declared optional
> as `""` and a model told to omit the key physically cannot (and the
> same `""` on `run_steps`/`run_test_file` falls through to the default
> session name rather than minting a session named the empty string),
> and `run_steps` passing `config.cdp` onto an existing session now ends
> its warning with a pointer to `run_errand`; (7) an errand naming a tab
> that matches nothing is refused with the browser's open tabs listed, so
> the caller can re-name one from what is actually open; one that matches
> two is refused naming both candidates; and the candidate set is only
> ever the filtered listing — an `iframe`, `browser_ui` or `*-dialog`
> target is never a candidate, however well it matches; (8) a live routing
> probe (both run tools — widened by [tab-peek](tab-peek.md) to all
> three tab tools, scoring read-vs-drive routing and argument-following
> alongside tool choice — offered to a real model, a matrix of
> phrasings from "run my login test" to "go export the report on my
> OpenRouter tab") is
> run per supported host model and its table recorded here, misses
> reported as product findings, never asserted as test failures.
>
> Five vitest suites carry (1)-(7) between them, and which carries what is
> part of the rule rather than an accident of where a test was written.
> `tests/mcp-errands-real-app.test.ts` drives (1), (2), (3), (4), (6) and
> (7) through a real in-memory MCP client against the real API server,
> with only the browser and the step executor faked — including the real
> `run_steps` session that makes (2) and the session half of (3)
> checkable at all. Two clauses sit outside its reach and are named
> elsewhere. **(1)'s run-in-flight half** — the count `/health` reports and
> the `POST /admin/shutdown` 409 — is asserted only in
> `tests/api-server-errands.test.ts`, and the reason is the client, not the
> app: both routes ARE served here (`createApiServer` registers them
> unconditionally, [src/server/api-server.ts:204](../src/server/api-server.ts:204)
> and [:272](../src/server/api-server.ts:272)), but this suite drives MCP
> tools, and neither half has a tool-shaped door — nothing in the MCP
> surface stops the server, and reading the count back through
> `server_status` would be an assertion about that tool's own probe rather
> than about the errand. **(6)'s `run_steps` warning ending** fires on the
> session door rather than on `run_errand`, so it is asserted only in
> `tests/mcp-cdp-seam.test.ts`.
> `tests/api-server-errands.test.ts` drives the same
> real API server over raw HTTP and owns (5), because its claims are
> about which page object was closed and which was raised: they can only
> be made at the mocked Playwright seam, and no MCP result exposes it.
> `tests/mcp-errands-seam.test.ts` runs the tool against a stubbed API
> client, which is the only place the surface itself can be examined:
> every `tab` spelling and the union it matches over, the profile
> normalisation, the shape of (7)'s two refusals over a fixture listing —
> the browser's whole tab list in the zero-match one, and every candidate's
> `title`, `url` and `targetId` in the several-match one — and (6)'s
> `session_id` refusal, which like §Act's `[skill:]`/`[tool:]` one is
> proved there to fire before any browser work at all: no listing, nothing
> on the wire.
> That does not make it the owner of (6) or (7): the real-app suite runs
> those same refusals end to end over the browser's real listing, and pins
> the zero-match one word for word against the exported `errandTabNotFound`
> builder.
> The `close_cdp_tab` half of (3) is a registry guard rather than an
> errand call, so it lives in `tests/cdp-registry.test.ts` and
> `tests/mcp-cdp-seam.test.ts`. (2), the human half of (5), and (8)
> additionally run live.

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
created, and never revisited ([src/server/session-manager.ts:1151](../src/server/session-manager.ts:1151)
is `createSession`'s only call site — inside the miss-arm of a lookup by
session name). The MCP tools default every `run_steps` call to the **same**
session name (`mcp:steps-<pid>-<projecthash>`,
[src/mcp/tools.ts:267](../src/mcp/tools.ts:267)), so the first `run_steps`
of a server's life decides the browser for every later call. Measured live
on 2026-08-12: the only session on the project server was
`mcp:steps-9268-83ea9b2d`, sitting on `about:blank` in a plain launched
browser, while the user asked — repeatedly, via an agent — for work on a
CDP tab named "Activity | OpenRouter". Every request found the session
alive, reused it, and the named tab never reached the attach code. The
warning added by [cdp-session-binding](cdp-session-binding.md)
([src/mcp/tools.ts:542](../src/mcp/tools.ts:542)) correctly reported that
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
  [src/mcp/cdp.ts:136](../src/mcp/cdp.ts:136), the registry behind `GET
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
  [src/browser/manager.ts:1369](../src/browser/manager.ts:1369)) is
  handed only that exact spec — the first-match-wins arm of
  `resolveCdpTab` is never asked to arbitrate. Nothing about a previous
  errand's resolution is remembered or reused.
- **Act.** Run the steps with the same executor, action vocabulary and AI
  resolution sessions use. A step neither knows nor cares whether a
  session or an errand is running it. `[skill: …]` and `[tool: …]` are the
  exception, refused by name — the same `[skill:`/`[tool:` token rule
  `run_steps` already refuses in user scope
  ([src/mcp/assemble.ts:75](../src/mcp/assemble.ts:75)) — because an
  errand deliberately carries no `skillsDir`/`toolsDir`. Section calls
  need no refusal: they resolve only through the `sections` map a parsed
  test file supplies ([src/mcp/types.ts:168](../src/mcp/types.ts:168)),
  which a fileless request never carries, so a bare section-name line is
  already just prose. The errand DOES carry a synthetic `testFilePath`
  (`<project_root>/.aiui-errand.md`, the same device `run_steps` already
  uses, [src/mcp/assemble.ts:335](../src/mcp/assemble.ts:335)) and an
  optional `env_name` — that path is the only thing the server resolves a
  project root from
  ([src/server/project-bundle.ts:56](../src/server/project-bundle.ts:56)),
  and without it the project layer of `effectiveSettings` would silently
  fall back to server defaults. `${env.X}` resolves from the project's
  environment **only when `env_name` names one**: with no `env_name` the
  server builds no env bundle (`if (envName)`,
  [src/server/project-bundle.ts:97](../src/server/project-bundle.ts:97))
  and the placeholder reaches the AI as literal text — there is no
  default-env concept — so `run_errand` emits the same
  pass-`env_name`-to-resolve warning `run_steps` already does
  ([src/mcp/assemble.ts:743](../src/mcp/assemble.ts:743)).
  `{{placeholders}}` resolve only from the errand's own earlier `store
  as` captures. An errand runs uncached: nothing keyed on the synthetic
  path is written.
- **Return.** The response is a receipt: an `errandId` the server mints
  per request (alive only while the errand runs — see item (4)), the root
  the errand resolved against and its `scope`
  ([mcp-no-project](mcp-no-project.md) §Locked: every result says which
  root it used — an errand's whole project layer hangs off that
  resolution), per-step outcomes, every `store as` capture (this is where variables go — to the
  caller, who is the brain here; the server keeps no scope), the final
  `url` and `title` of the borrowed tab, a list of anything the errand
  opened along the way and a second of what of it is still open, and the
  `effectiveSettings` it ran under — an errand has no session to hold
  overrides, so the chain is server base →
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
  ([src/browser/cdp-discovery.ts:240](../src/browser/cdp-discovery.ts:240)) —
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
  ([src/server/session-manager.ts:1554](../src/server/session-manager.ts:1554)),
  **extended to carry each holder's status**. The extension is not
  optional: the join today returns `targetId → sessionId` with no status
  and keeps only the first holder per target
  ([src/server/session-manager.ts:1561](../src/server/session-manager.ts:1561)),
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
  per-port serialisation and tab-collision guards, and its subject —
  parallel sessions — is untouched. What this story adds is a **named,
  bounded amendment to that decision**: a tab-collision guard now exists,
  taken by errands only; session behaviour is unchanged. (It also widens
  [server-lifecycle](server-lifecycle.md)'s descriptive gloss of a run —
  "sessions currently executing steps" — to include errands; the locked
  definition, "no run in flight", already covers them.) A `run_steps`
  batch arriving while an errand drives the tab proceeds; the hazard is
  bounded by one errand request and both sides' receipts make what
  happened explainable.
- `close_cdp_tab`'s hold guard consults the errand lock the same way it
  consults sessions: a tab an errand is driving or opened refuses the
  close, naming the `errandId` and offering wait-and-retry. **This is a named amendment
  to [cdp-tabs](cdp-tabs.md) §1, §2 and §5** — §2 gains the errand check
  as a numbered step beside the session refusal (before the last-tab
  gate, for the same remedy-quality reason cdp-tabs ordered 3 before 4,
  and inside the same port-keyed close queue); §5's error table gains the
  row (condition: errand-held tab; message names: the `errandId`, its tab,
  and whether the tab is the errand's borrowed tab or one it opened; next
  action: wait for the errand to finish, then retry — for an errand-opened
  tab the message adds that it will normally be gone by then, so the close
  becomes moot); and §1's
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
   [src/browser/manager.ts:1415](../src/browser/manager.ts:1415).
4. The pre-existing-pages guard ([src/browser/manager.ts:1388](../src/browser/manager.ts:1388),
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
                                # refuses any call carrying a NON-EMPTY value before any
                                # browser work. "" is treated as absent: auto-filling
                                # serializers send it for optionals a model cannot omit
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

The tool's name itself is a second **named amendment**, this time to the
`cdp` prefix rule ([mcp-cdp-browser](mcp-cdp-browser.md) §5, restated as
locked in [cdp-tabs](cdp-tabs.md) — "the tool name says the scope"):
`run_errand` is CDP-only by construction yet carries no `cdp`, because
§Routing 2 measured that the name must echo the user's words at the
moment of choice, and users say "my tab", not "my CDP browser". The
prefix rule's own rationale — a bare name claims authority over both
browser kinds — is answered differently here: the errand cannot reach a
launched browser at all, and its refusals say so. The naming probe
(§Open questions) tests a `cdp`-carrying spelling alongside the bare
ones; if the probe contradicts the routing argument, the amendment
dissolves and the prefix wins.

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

`run_steps` changes in three places, none behavioural: its ignored-CDP
warning gains the ending *"…or use run_errand if you just want to drive
that tab"*; the shared `CDP_NOTE` in both run tools' descriptions
([src/mcp/tools.ts:1234](../src/mcp/tools.ts:1234), shared with
`run_test_file` — the added sentence is phrased to be true of both) gains
the whose-browser decision rule from §Routing; and `CDP_NOTE`'s existing
"Tab:" paragraph — which today teaches the `config.cdp.tab:
"targetId:<id>"` flow for *"a tab that is already open — one the user set
up by hand"*, exactly the ownership case §Routing sends to `run_errand` —
is reworded rather than left to say both things at once: the
`config.cdp.tab` flow remains documented for **binding a session** to a
user tab (still the session-door path a *test-file* run against one goes
through, which is why the reword must stay true for `run_test_file`),
and the one-off-driving case now points at `run_errand`. Session *behaviour* is
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
3. **Parameter funnel.** The errand and the peek
   ([tab-peek](tab-peek.md)) are the only first-class tab-name slots.
   The session door's `config.cdp.tab` does still accept
   `title~`/`url~` — but buried inside a config object, resolved
   first-match-wins, and documented (`CDP_NOTE`'s "Tab:" paragraph) for
   target ids only — so the funnel narrows rather than forces, and
   completing it is the deprecation question §Open questions records.
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
[src/browser/manager.ts:1369](../src/browser/manager.ts:1369), then
`resolveCdpTab` — [src/browser/manager.ts:1010](../src/browser/manager.ts:1010) —
handed only an exact `targetId:` spec); the pre-existing-pages guard
([src/browser/manager.ts:1388](../src/browser/manager.ts:1388)) and
disconnect-not-kill semantics (`closeBrowser`,
[src/browser/manager.ts:1482](../src/browser/manager.ts:1482)); the step
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
ON default ([src/mcp/tools.ts:703](../src/mcp/tools.ts:703)), and no tool
passes `autoStart: false` — the "auto-start list" that cdp-tab-focus §5,
cdp-tabs §3 and both stories' §Composition rows describe is a list
`server-start.ts` does not have, and all four sites are corrected in this
story's PR so the next tool story stops inheriting the claim; and add it
to the seam + dialect tool-name manifests (`mcp-seam.test.ts`,
`mcp-schema-dialect.test.ts`) and `mcp-content-blocks.test.ts`
`argumentsFor()` inventories.

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

## Live pass record

**2026-08-13, MCP-client smoke — 17/17 checks passed.** A real MCP client
over stdio spawned the real `aiui mcp`, which auto-started a fresh API
server for a throwaway project; `start_cdp_browser` launched a real
project-scope Chrome, and `run_errand` drove it with real AI resolution
(model `aibroker/openrouter/openai/gpt-5.6-luna`, 3/3 steps): navigation,
a click, and a `store as` capture returned in the receipt alongside
`errandId`, root+scope, final url/title, empty `openedTabs` and the
`effectiveSettings` echo. `list_sessions` was identical before and after
(item 1). A zero-match `tab` refused listing the open tabs, and
`session_id` refused naming `run_steps` before any browser work (items 6
and 7). Item (2) ran in full: `run_steps` bound a session to the same tab
by `targetId:`, the errand still worked over it while idle, and the
session's next batch succeeded afterwards — the two-client coexistence
re-proved through the real tool.

Two observations from the same pass, neither an errand defect: a project
`.env` carrying a `SERVER_URL` routes every tool at that project to the
server it names — the first driver attempt inherited the repo's own
`.env` and reached the developer's live server (caught before any errand
ran; a throwaway project must mint its own `SERVER_URL`); and directly
after a same-process `close_session`, `close_cdp_tab` on that session's
tab still refused naming it — a second attempt moments later (fresh MCP
process, `allow_foreign_session` close, ~3s settle) closed the session,
the tab and the browser cleanly, so session teardown's hold release lags
its response.

**2026-08-13, fleet-console pass — end-to-end success, with a routing
finding.** An isolated Agent Fleet console instance (own user-data-dir
and fleet.db, this repo's MCP server registered from the build worktree)
drove the same throwaway browser through a real agent. Observed, per the
reported-never-asserted rule:

- **Tool choice routed correctly, first try.** OpenCode on
  `gemini-pro-latest`, prompted "go click the Export report button on my
  open tab…", picked `run_errand` unprompted — layers 1-3 of §Routing
  did their job on a fast model.
- **The two-chrome-defaults refusal fired exactly as written** — a
  user-root and a project chrome `default` were both live, and the
  refusal named both and gave the `scope: "project"` remedy verbatim.
- **Layer 4 did not rescue this model at the argument level.** Gemini
  repeated the identical scope-less call after the remedy sentence, and
  again after a "read the error and do what it says" nudge — reading a
  browser listing that showed both scopes in between — and both times
  told the user the errand had succeeded when the tool card said
  `failed`. Only an instruction naming the literal argument landed.
- **With the argument supplied, the whole chain worked**: the errand
  drove the tab, the capture came back in the receipt, and the agent
  quoted the real token. The success claim was finally true.

The findings feed two §Open questions: the two-defaults UX (the refusal
is correct and honest, but a fast model may never follow it — tab-first
disambiguation would have made the first call succeed, since the named
tab existed in only one browser) and the item (8) probe, which should
score argument-following per model, not just tool choice.

**2026-08-13, post-merge field report (Paul's live fleet, gpt-5.6-luna
via OpenCode).** "Bring the Activity one to the front" worked
(`focus_cdp_tab`), then "now go to Credits" looped: every `run_errand`
call carried `session_id: ""` and was refused, and the refusal's "call
run_errand again without session_id" could never land — the provider
layer serializes every declared optional as `""`, so the model cannot
omit the key. Fixed the same day: an empty/whitespace `session_id` is
now treated as absent on all three run tools (the refusal fires on
non-empty only), the same normalisation `profile` and `env_name`
already had. The general lesson joins
[mcp-tool-schema-portability]: a declared-but-refused field must refuse
on VALUE, not presence, or auto-filling serializers turn the refusal
into a livelock.

Still to run live: the human half of item (5) (does the borrowed tab
visibly come forward), and the item (8) routing probe matrix per host
model.

## Open questions

- **Leave-where-found.** Should an errand offer `restore_url: true` to
  navigate the tab back to where it started? Default no — the receipt
  reports the final location — but a borrowing mid-someone's-work case may
  want it.
- **Naming.** `run_errand` vs `drive_tab` — plus a `cdp`-carrying
  spelling (`drive_cdp_tab`), per the prefix-rule amendment in §Tool
  surface. The probe (verification item 8, widened by
  [tab-peek](tab-peek.md) to offer all three tab tools, score
  read-vs-drive routing and argument-following, and test the peek
  spellings alongside) should run before any name freezes.
- **Scope search on a miss.** Ambiguity is settled — a profile name live
  under both roots refuses naming both (§Attach). Still open: when the
  named profile simply isn't running in the requested scope but is in the
  other, should the refusal add a "did you mean the user-scope one?" hint?
  A UX decision the first live use should settle.
- **`config.cdp.tab` on `run_steps`.** The vestigial tab slot on the
  session door predates errands. Deprecating it would complete the funnel;
  cdp-session-binding's warnings make it survivable meanwhile.
