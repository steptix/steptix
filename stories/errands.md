# Errands — borrow a tab, drive it, hand it back

> **Verification rule for this story.** "Done" means: (1) with a CDP browser
> holding a signed-in tab that NO session has ever touched, `run_errand`
> naming that tab by title drives real steps in it and returns a receipt —
> and `list_sessions` afterwards shows **no new session**; (2) while a
> session is attached to that same tab but idle, the same errand still works,
> and the session's next `run_steps` afterwards still works (the two-client
> coexistence this story measured on 2026-08-12, re-proved through the real
> tool rather than a raw socket); (3) an errand arriving while ANOTHER errand
> is driving that tab — or while a session is mid-`executeSteps` on it — is
> refused with a message naming who holds the tab, and succeeds on retry once
> the holder finishes; (4) the receipt carries every `store as` capture, the
> per-step outcomes, and the tab's final `url` and `title`, and NOTHING of the
> errand survives on the server — no entry in any session map, no variable
> scope, no report file unless asked for; (5) a tab the errand did not open is
> never closed by it, a tab it DID open during its steps is gone by the time
> it returns, and the borrowed tab is front-and-center when it finishes; (6)
> `run_errand` with anything session-shaped (`session_id`) is a schema-level
> refusal, and `run_steps` passing `config.cdp` onto an existing session now
> ends its warning with a pointer to `run_errand`; (7) an errand naming a tab
> that matches nothing, or two tabs, refuses honestly — naming the candidates
> — rather than guessing; (8) a live routing probe (both tools offered to a
> real model, a matrix of phrasings from "run my login test" to "go export
> the report on my OpenRouter tab") is run per supported host model and its
> table recorded here, misses reported as product findings, never asserted as
> test failures. A vitest suite drives (1)-(7) through a real in-memory MCP
> client against the real API server; (2) and (8) additionally run live.

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
session name). The MCP tools default every call to the **same** session name
(`mcp:steps-<pid>-<projecthash>`, [src/mcp/tools.ts:235](../src/mcp/tools.ts:235)),
so the first `run_steps` of a server's life decides the browser for every
later call. Measured live on 2026-08-12: the only session on the project
server was `mcp:steps-9268-83ea9b2d`, sitting on `about:blank` in a plain
launched browser, while the user asked — repeatedly, via an agent — for
work on a CDP tab named "Activity | OpenRouter". Every request found the
session alive, reused it, and the named tab never reached the attach code.
The warning added by [cdp-session-binding](cdp-session-binding.md)
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

- **Attach.** Resolve the tab fresh, every time: discover the running CDP
  browsers from the registry ([src/browser/cdp-registry.ts](../src/browser/cdp-registry.ts)),
  connect, and match the named tab. Exactly one match proceeds; zero or
  several refuse, naming what was found. Nothing about a previous errand's
  resolution is remembered or reused.
- **Act.** Run the steps with the same executor, action vocabulary and AI
  resolution sessions use. Steps are unchanged; a step neither knows nor
  cares whether a session or an errand is running it.
- **Return.** The response is a receipt: per-step outcomes, every `store as`
  capture (this is where variables go — to the caller, who is the brain
  here; the server keeps no scope), the final `url` and `title` of the
  borrowed tab, and a list of anything the errand opened along the way.
- **Detach.** Disconnect from the browser without disturbing it. Close tabs
  the errand opened; never the borrowed tab or any other pre-existing one.
  Bring the borrowed tab to the front on the way out — hand back the keys
  visibly.

### The wheel: one driver at a time

A tab has one steering wheel. Concurrent CDP *clients* on one tab are fine —
measured 2026-08-12 against a live "Activity | OpenRouter" tab: two
simultaneous flattened `Target.attachToTarget` clients on the browser
endpoint (the exact mechanism two Playwright `connectOverCDP` connections
use) both evaluated in the page, one detached, the survivor was unaffected.
Concurrent *drivers* are not fine: interleaved input, both clients handling
the same dialog, and page-global emulation overrides are all
simultaneity hazards.

So the server keeps a per-tab (targetId-keyed) turn lock:

- An errand takes the lock for its lifetime. Release is not a step anyone
  can forget — finishing *is* releasing.
- A second errand on a held tab is refused with the holder named, and told
  to retry; it does not queue silently.
- A session that is actively executing steps against a user tab holds the
  same lock for the duration of the batch. An idle session holds nothing —
  idle is the safe case, mid-run is the dangerous one.

The lock cannot cover the human. The user is always the implicit senior
driver, and no lock stops them typing into the tab mid-errand. The receipt
is the mitigation: it reports what the errand actually did, so a surprising
page state is explainable rather than mysterious.

### House rules (enforced in the detach path, not promised in prose)

1. Never close, navigate-away, or sign out a tab the errand did not open.
   Navigation *as a requested step* is allowed — the receipt records where
   the page ended up.
2. Tabs opened during the errand are the errand's coat: taken when leaving,
   unless a step explicitly said keep.
3. End with the borrowed tab in front (`bringToFront`, the same courtesy the
   attach path already extends at [src/browser/manager.ts:1390](../src/browser/manager.ts:1390)).
4. The pre-existing-pages guard ([src/browser/manager.ts:1358](../src/browser/manager.ts:1358))
   is the errand's whole personality: everything it protects for CDP
   sessions, an errand applies to every page but its own.

## Tool surface

```
run_errand {
  tab:      string          # required. Title or URL (substring/pattern), resolved fresh.
  profile?: string          # CDP profile name, default "default" — same addressing as
                            # cdp-session-binding, port never required.
  scope?:   'project'|'user'
  steps:    string[]        # same step language as run_steps
  keep_open?: boolean       # leave errand-opened tabs behind (default false)
}
```

Deliberately absent: `session_id` (schema refuses it — errands have no
sessions), `config` (no baseUrl/timeout bundle; an errand inherits the
project's), and any report-path plumbing (the receipt IS the report; an
HTML artifact is opt-in later if ever needed).

`run_steps` changes in exactly one sentence: its existing ignored-CDP
warning gains the ending *"…or use run_errand if you just want to drive
that tab."* Sessions are otherwise untouched — every behaviour, test, and
story about them stands.

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
   self-correcting sentence (the §Tool surface warning, and the schema
   refusal naming the other tool). This is the layer that rescues small
   models, because it converts a wrong pick into one extra round-trip.

Per the verification rule, routing is *probed live and reported*, never
asserted: a miss is a product finding about a model, and the record of it
belongs in this story the way the fleet console's spec records its own
misses.

## What already exists vs what is new

Reused unchanged: CDP discovery and profile addressing
([src/browser/cdp-registry.ts](../src/browser/cdp-registry.ts)), the
connect-and-resolve path (`connectOverCDP` + `resolveCdpTab`,
[src/browser/manager.ts:1344](../src/browser/manager.ts:1344)), the
pre-existing-pages guard and disconnect-not-kill semantics
([src/browser/manager.ts:890](../src/browser/manager.ts:890)), the step
executor and AI resolution, and report assembly (rendered into the receipt
instead of onto disk).

New: the `run_errand` tool and schema; an `ErrandRunner` beside — not
inside — `SessionManager` (it never touches the sessions map, which is what
makes verification item (1) checkable); the per-tab turn lock, taken by
errands always and by sessions during CDP-tab step batches; the receipt
shape.

## Build order

1. **Tool + runner.** Attach-fresh-every-time alone dissolves the measured
   stale-session failure. No lock yet; collisions are possible but were
   always possible.
2. **The wheel.** Per-tab lock, refusal messages, session batch
   participation.
3. **Receipt polish + routing probe.** Capture forwarding, opened-tabs
   accounting, the live probe matrix per host model, results recorded here.

## Open questions

- **Leave-where-found.** Should an errand offer `restore_url: true` to
  navigate the tab back to where it started? Default no — the receipt
  reports the final location — but a borrowing mid-someone's-work case may
  want it.
- **Naming.** `run_errand` vs `drive_tab`. The probe (verification item 8)
  should test both spellings before the name freezes.
- **Two servers, two chrome-defaults.** Project scope and user scope each
  run browsers whose profile is called `default`
  (`.aiui/cdp-profiles/chrome-default` under both roots — measured, both
  live at once, each holding an OpenRouter-titled tab). `scope` defaults to
  `project`; whether an errand should ever search both scopes on a miss, or
  refuse with a "did you mean the user-scope one?" hint, is a UX decision
  the first live use should settle.
- **`config.cdp.tab` on `run_steps`.** The vestigial tab slot on the
  session door predates errands. Deprecating it would complete the funnel;
  cdp-session-binding's warnings make it survivable meanwhile.
