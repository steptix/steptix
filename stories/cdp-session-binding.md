# CDP session binding — name the browser, see the binding, hear the miss

> **Verification rule for this story.** "Done" means: (1) `run_steps` with
> `config.cdp.profile: "default"` attaches to that profile's running browser
> without the caller knowing its port, and refuses with a runnable remedy when
> the profile exists but is not running; (2) a run that creates a session while
> the project has a CDP browser running, and passes no `config.cdp`, comes back
> with a **warning** saying a fresh disposable browser was launched instead;
> (3) a run that passes `config.cdp` on a session that already exists comes
> back with a **warning** that it was dropped, rather than only
> `configApplied: false`; (4) `list_sessions` reports `cdp: {port, profile}` for
> an attached session and `null` otherwise; (5) `run_steps` and `run_test_file`
> descriptions tell an agent that this project may have a CDP browser running
> and how to use it. Nothing auto-attaches.

## Context

Measured, not assumed. Three `run_steps` calls, all "Navigate to
facebook.com", against a project with Chrome running on a CDP port:

| | `config.cdp` | `configApplied` | ran in |
|---|---|---|---|
| A | — | false | a fresh disposable browser |
| B | `{port: 23148}` on a new session | **true** | the CDP browser |
| C | `{port: 23148}` on an existing session | **false** | the disposable one again |

B's tab id then appeared in `list_cdp_browsers`; A's never did. C returned
`status: "passed"`, `warnings: []`, and ran in the wrong browser in silence.

So the machinery works. What fails is everything around it:

1. **The link is a volatile integer.** `start_cdp_browser` returns a port, and
   the agent must carry that number into a later `config.cdp.port`. Ports are
   assigned by the browser and change on every launch — the tool's own
   description says so. The agent is being asked to remember the one property
   of the browser guaranteed not to be stable.
2. **Nothing prompts at the point of the call.** The instruction to pass a port
   lives in `list_cdp_browsers` and `start_cdp_browser`. By the time
   `run_steps` is called — possibly turns later — the tool being invoked says
   nothing about CDP at all.
3. **A lost intent is silent.** Run C is the dangerous one. `config` is
   correctly refused on an existing session (the browser already exists and
   cannot be swapped), but the caller asked for a signed-in browser, did not
   get one, and was told nothing. For a feature whose entire purpose is "use my
   signed-in browser", a run that quietly executes signed-out **and passes** is
   the worst available outcome — it is the same "passes for the wrong reason"
   hazard `start_cdp_browser`'s description already warns about for profile
   reuse.

Run A is a usability failure. Run C is a correctness one.

## Locked decisions

- **Nothing auto-attaches.** The obvious fix — attach automatically when the
  project has exactly one running CDP browser — would fix run A with no agent
  cooperation, and would also silently run a clean-browser suite inside a
  signed-in profile. A test that passes for the wrong reason is worse than one
  that fails visibly. The warning tells the agent; it does not decide for it.

- **A profile name is the address; the port stays supported.** `chrome/default`
  is the same browser and the same logins tomorrow; `23148` is not. The agent
  is asked to carry the thing the user actually said ("chrome", "my signed-in
  one") rather than a number it had to look up. `{port}` keeps working — test
  files declare ports today, and `list_cdp_browsers` hands them out.

- **The profile is resolved MCP-side, not on the wire.** `config.cdp.profile`
  is turned into a port before the request is sent, so the wire shape stays
  `{port, tab?}` and `session-manager.ts` is untouched. This also makes the §6
  ownership gate trivially satisfied: a port resolved *from this project's own
  registry* is by construction one this project launched, so there is no new
  path by which an agent can name a browser it does not own.

- **A named profile that is not running is an error, not a launch.** Same rule
  as auto-attach: starting a browser is a visible act that belongs to
  `start_cdp_browser`. The refusal carries the exact call to make, so the agent
  recovers in one step instead of guessing.

- **The "you could have used a CDP browser" warning fires only when a session
  is created.** `config` is only honoured at creation, so that is the only
  moment the advice is actionable; warning on every subsequent call would be
  noise the agent cannot act on. It also confines the extra registry round-trip
  to runs that were already paying to launch a browser.

- **`list_sessions` reports the binding; it does not absorb
  `list_cdp_browsers`.** A count-or-flag on the session answers "which session
  is driving my signed-in Chrome?". Folding in the full browser inventory would
  make a cheap call wait on per-browser tab probing, and drag the foreign-tab
  privacy rule into a tool that has no policy of its own.

- **The server must retain the CDP binding to report it.** `ManagedSession`
  types `sessionConfig` as `{baseUrl?, timeout?}`, so `cdp` is assigned but
  invisible. Reporting it means widening that type.

- **The profile travels on the wire as an informational label** — *revised
  during implementation.* The first plan had the server resolve port → profile
  from its own registry at list time. That needs two things it does not have:
  `projectRoot` on `ManagedSession`, and a `knownProfiles()` probe sweep on
  every `list_sessions` — a per-profile port probe added to a tool that already
  carries a 5 s timeout because one hung page can block it. Sending the label
  the MCP server already resolved costs one optional field and no lookups.
  Safe because the label is **descriptive, never selective**: `port` still
  chooses the browser and still clears §6's gate, so the worst an agent can do
  is mislabel a browser it had already legitimately attached to.

## Design

### 1. `config.cdp` accepts a profile

Schema ([src/mcp/schemas.ts](../src/mcp/schemas.ts)) — `port` becomes optional
and `profile` joins it, with **exactly one required**:

```
cdp: { port?: number, profile?: string, tab?: string }
```

Both absent, or both present, is a pre-flight refusal. Both-present is refused
rather than resolved-and-compared: the two could disagree, and picking a winner
silently is how run C happened.

Resolution, in `assemble.ts`'s caller (`tools.ts`, beside the existing gate
call — it is the only place with an `ApiClient`):

1. `getCdpBrowsers({projectRoot})`.
2. `running` match on profile (and `engine` when the caller gave one) → use its
   port. The §6 gate is then skipped: this port came from the registry, not
   from the agent.
3. In `available` → refuse, naming the exact `start_cdp_browser` call.
4. Nowhere → refuse, listing the profiles that do exist.

`{port}` keeps its current path unchanged, gate included.

### 2. Two warnings

Both are `warnings[]` entries on the run result, so they reach the agent
without changing `status`.

**W1 — dropped.** `config.cdp` was supplied and the session already existed.
Detected with what is already in hand (`request.config?.cdp` set,
`configApplied` false); costs nothing:

> `config.cdp` was ignored: session "mcp:x" already exists, and a session's
> browser is fixed when it is created. **These steps ran in the session's
> existing browser, not the CDP one.** To use the CDP browser, close the
> session first (`close_session`) and run again.

**W2 — available but unused.** A session was created, no `config.cdp` was
given, and the project has ≥1 running CDP browser:

> This run launched a fresh, signed-out browser, but this project has 1 CDP
> browser running (chrome "default"). If you meant to use it, pass
> `config.cdp: {profile: "default"}` — on a new session, since config is only
> read at creation.

W2 needs a `getCdpBrowsers` round-trip. It is issued only when a session was
created and no `cdp` was configured — the run was already launching a browser,
so one call to the same server is noise. A failure to reach the registry drops
the warning; it must never change the run's status.

### 3. `list_sessions` reports the binding

- `ManagedSession.sessionConfig` widens to keep `cdp?: {port, tab?}`.
- `SessionListItem` gains `cdp: {port: number; profile: string | null} | null`.
  `profile` is resolved from the server's CDP registry by port at list time —
  it is not on the wire — and is `null` when that browser is gone.
- The MCP output schema gains the same field. Nullable, not optional: a missing
  key is fatal to `structuredContent` validation, a null one is not.

### 4. Descriptions

`run_steps` and `run_test_file` gain a short paragraph — the only text
guaranteed to be in front of the model at the moment of the call:

> This project may have a persistent CDP browser running, holding real logins.
> Steps run in a fresh disposable browser unless you pass
> `config.cdp: {profile: "<name>"}`. Call `list_cdp_browsers` if you are not
> sure. Config is read only when the session is created, so pass it on the
> first call for a session — not later.

## Out of scope

- Auto-attaching (rejected above).
- Auto-launching a dormant profile (rejected above).
- Merging `list_cdp_browsers` into `list_sessions`.
- Changing the §6 ownership gate's rules for a caller-supplied `port`.
- Any change to how a test file's `## Config` declares `cdp:`.

## Composition

| File | Change |
|---|---|
| [src/mcp/schemas.ts](../src/mcp/schemas.ts) | `cdp` gains `profile`; `port` optional; `cdp` field on the session output. |
| [src/mcp/assemble.ts](../src/mcp/assemble.ts) | Carry a tool-supplied `profile` through `projectConfig` as an unresolved marker; W1's precondition. |
| [src/mcp/cdp.ts](../src/mcp/cdp.ts) | `resolveProfileToPort`, beside `assertPortAttachable`. |
| [src/mcp/tools.ts](../src/mcp/tools.ts) | Resolution before the gate; both warnings; `list_sessions` mapping; the two descriptions. |
| [src/mcp/errors.ts](../src/mcp/errors.ts) | Profile-not-running / profile-unknown / both-or-neither refusals. |
| [src/server/session-manager.ts](../src/server/session-manager.ts) | Retain `cdp` on `sessionConfig`; `SessionListItem.cdp` with registry lookup. |

## Tests

### Unit / seam (vitest)

In [tests/mcp-cdp-seam.test.ts](../tests/mcp-cdp-seam.test.ts):

- `{profile}` on a running browser → resolves to its port, gate **not** called.
- `{profile}` on an `available` profile → refused, message names
  `start_cdp_browser` and the profile.
- `{profile}` unknown → refused, message lists the profiles that exist.
- `{port}` unchanged → still gated (regression guard on §6).
- `{port}` **and** `{profile}` → refused, neither silently wins.
- Neither → refused.
- W1: `cdp` supplied, session exists → warning present and names
  `close_session`; `configApplied` still false.
- W2: session created, no `cdp`, one browser running → warning names the
  profile.
- W2 **not** emitted when a session is reused, when `cdp` was supplied, or when
  nothing is running — three separate cases, because a warning that cries wolf
  gets ignored and this one guards a correctness bug.
- W2 survives a `getCdpBrowsers` failure: warning dropped, `status` unchanged.
- `list_sessions` maps `cdp` through, and reports `null` for a plain session.

### Live (manual)

Reproduce the three-run table from Context. A must now carry W2, C must carry
W1, and B must still work when addressed as `{profile: "default"}` with no port
anywhere in the call.

## Risks / open

- **W2 costs a round-trip per session creation.** Confined to that case, and a
  session creation is already the expensive path. If it ever shows up, the
  server could carry a browser count on the stream's first event instead.
- **The agent may still ignore both warnings.** They are advisory by decision —
  the alternative is auto-attaching, which is rejected. What changes is that a
  wrong-browser run is now *recorded* rather than invisible.
- **`profile` collides across engines.** `chrome/default` and `edge/default`
  are different browsers with the same profile name. Resolution matches on
  profile alone unless `engine` is also given; with both engines running the
  same profile name, that is ambiguous. Refuse and name both rather than
  guessing — cheap to get right, nasty to get wrong.

# Plan

## Workstream graph

```
W1 descriptions ──┐
W2 warnings ──────┼──> W4 profile addressing
W3 list_sessions ─┘
```

W1–W3 are independent. W4 lands last because its tests assert against the
warning text W2 introduces.

## Workstreams

**W1 — descriptions.** §4. Text only; no behaviour. Ships the cheapest fix to
the reported bug on its own.

**W2 — warnings.** §2. W1 first (free), then W2's registry probe. The
"not emitted when…" cases are the point of this workstream, not an extra.

**W3 — `list_sessions` binding.** §3. Server retains `cdp`, resolves the
profile at list time, MCP maps it through.

**W4 — profile addressing.** §1. Schema, resolution, refusals, and the gate
skip — with the both-present and neither-present refusals written first, since
they are the cases that keep run C from coming back in a new shape.

## Repo gotchas

- **Rebuild `dist/` before testing by hand** — the MCP server the host (e.g.
  Claude Code) spawns runs `dist/`, and W3 additionally needs the **Sessions
  API server** restarted, since that is a separate process.
- **The full vitest run is intermittently flaky** (worker-pool crash, all files
  at once, ~8s, 0 tests). Re-run the single file before believing a regression.
- **Output schemas are validated by the SDK**, and a missing key degrades the
  result to `isError` with no structured content. Every new field is
  `.nullable()`, never optional.
