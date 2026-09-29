# CDP browsers — the framework launches them, agents drive them

> **Verification rule for this story.** "Done" means: (1) from Claude
> Code, `start_cdp_browser` launches a headed Edge and returns
> `{engine:'edge', profile:'default', port:<OS-assigned>,
> outcome:'launched_into_new_profile'}` — and the browser was spawned
> by the **API server**, not the MCP process; (2) the user signs into a
> real site in that window by hand, then `run_steps` with that port
> runs steps **in that logged-in tab**, and the returned `sessionId`
> works for a second call that still sees the session; (3) closing the
> MCP host entirely, reopening it, and calling `start_cdp_browser` again
> returns `outcome:'reused_running_browser'` on the **same** port with
> the browser **still signed in**; (4) `GET /cdp/browsers` returns that
> browser to a plain `curl`, proving the registry is not MCP-private;
> (5) a browser started by another client appears under `foreign` with
> `tabs:null`, never under `running`, and a `run_steps` naming its port
> is refused until the config opt-in is set; (6) two `start_cdp_browser`
> calls racing for the same engine and profile produce **one** browser,
> not two; (7) `start_cdp_browser {engine:'edge', profile:'admin'}` runs
> alongside the `default` Edge on its **own** port with its **own**
> login; asking for `admin` again returns
> `outcome:'launched_into_existing_profile'` rather than an error; and
> `reset:true` returns `launched_after_reset` with a signed-out browser,
> leaving `default` untouched; (8) after closing the `admin` browser it
> appears under `available` with no port, and `run_steps` cannot attach
> to it; (9) after a CDP run ends the browser process is **still
> running** with its tabs intact; (10) three tests run in parallel
> against one signed-in profile each report, per step, the `targetId`
> of the tab that step actually drove — and the report shows it. A vitest suite driving the MCP server through a real in-memory
> MCP client, a route test through the real `createApiServer` app over
> HTTP, and the live check against real Chrome and Edge are all part of
> the contract.

## Context

An agent should be able to say *"start an Edge browser over CDP"* and
get back something it can send test steps to. Today it cannot: the MCP
layer refuses to select a browser
([src/mcp/assemble.ts:83](../src/mcp/assemble.ts:83)), and nothing in
the framework launches a CDP browser outside the flick-vscode extension.

Almost every piece already exists, in the wrong package:

- **Launching** — `launchBrowserWithCdp`
  ([flick-vscode/src/extension/browser-launcher.ts](../flick-vscode/src/extension/browser-launcher.ts)):
  per-OS binary resolution for Chrome and Edge, array-form spawn with
  `--remote-debugging-port`/`--user-data-dir`, readiness poll.
- **Discovery** — `discoverCdpPorts`
  ([flick-vscode/src/extension/cdp-discovery.ts](../flick-vscode/src/extension/cdp-discovery.ts)):
  probes ports, classifies the engine from `/json/version`, enumerates
  `type:'page'` tabs, already classifies a Node `--inspect` endpoint as
  `engine:'node'` so it can be hidden.
- **Attaching** — the runner's `cdp`/`cdpTab` config
  ([stories/cdp-connection.md](cdp-connection.md)), including the
  `targetId:<id>` selector, and `api-server.ts`'s pass-through of
  `config.cdp`.

So this is a **relocation plus a gate**, not new capability. What is
genuinely new: the API server gains ownership of CDP browsers, and an
agent gains a safe way to ask for one.

### Two reframes that drive the design

**You cannot attach to your everyday browser.**
`--remote-debugging-port` is rejected on the default profile
([browser-launcher.ts:207](../flick-vscode/src/extension/browser-launcher.ts:207)),
so a normally-started browser has no CDP port and cannot be given one.
But a dedicated profile dir is **persistent**
([controller.ts:429](../flick-vscode/src/extension/controller.ts:429)):
launch once, sign in by hand, and the login is on disk from then on.
"Fresh browser" and "already-logged-in browser" are the same browser at
two points in its life — which is why one `start_cdp_browser` suffices.

**The server owns browsers, so the server launches them.**
[mcp-server.md](mcp-server.md) already locks *"One server owns
browsers, sessions, cache and lifecycle"* and makes the MCP layer a
pure HTTP client of the Sessions API. Spawning from the MCP process
would create a second owner — invisible to flick, to Steptix, to the
CLI, and duplicated across every MCP process. So launching lives behind
new Sessions API routes (§4) and every client, MCP included, is a
client of those.

## Amendments to locked decisions

Three shipped, reviewed decisions change here. Recorded rather than
silently contradicted.

| Story | Was | Now |
| --- | --- | --- |
| [mcp-server.md](mcp-server.md) §2/§3 and [assemble.ts:83](../src/mcp/assemble.ts:83) | "No `cdp`: that selects a live browser to attach to, which is not an agent's decision to make." Tool-arg `config` is `{baseUrl?, timeout?}` only | An agent **may** select a browser **this project's framework launched** (§3). Any other browser requires a human editing `steptix.config.json` (§6). The rationale is preserved, not dropped: the agent chooses among browsers it owns; a human decides whether it can reach anything else |
| [cdp-connection.md](cdp-connection.md) §"Why CDP doesn't auto-launch Chrome" | The harness never launches a browser for CDP; auto-launching against a fresh `--user-data-dir` would defeat every reason CDP was added | Correct for the *user's* profile, which we still never touch. It does **not** hold for a **persistent framework-owned** profile: a dir that survives relaunch accumulates exactly the logged-in state the original argument wanted. The rule is now scoped to "never launch against the user's own profile" |
| [flick-vscode-cdp-attach.md](flick-vscode-cdp-attach.md) locked row 4 | Dedicated profile, "trade-off is **no logged-in sessions** in the launched browser" | True only on the **first** launch. The stated trade-off is wrong for every launch after the user signs in once, and this story depends on that. Row 4's *decision* stands; its rationale is amended |

## Locked decisions

- **The API server launches and owns CDP browsers** (§4). No client
  spawns a browser — not MCP, not flick, not the CLI. This is the
  existing "one server owns browsers" decision applied, not a new one.
- **Framework-owned profiles only.**
  `<project_root>/.steptix/cdp-profiles/<engine>-<name>/`. The user's real
  profile is never read, copied, or passed as `--user-data-dir`.
  `.steptix/` is already gitignored ([.gitignore:14](../.gitignore:14)).
- **Profiles are named** (§1), defaulting to `default`. One profile per
  engine cannot express admin-vs-user, uat-vs-prod, or a
  deliberately-signed-out profile — and without names "start a *new*
  browser" has no meaning, since the singleton lock permits only one
  process per profile.
- **`reset` is in scope, not deferred** (§12). Shipping named profiles
  without a way to empty one half-solves the sign-in-flow case, which
  is one of the three the feature exists for. It is the only
  destructive operation here and carries five guards, of which the
  `.steptix-profile` marker is the one that does not depend on path logic
  being right.
- **Ownership is proved from disk** (§3), never from process memory.
  Both the server and the MCP process restart independently of the
  browser; a memory-only registry loses the browser on either restart
  and fails verification rule (3) by construction.
- **The browser picks its own port** (§3). Spawn with
  `--remote-debugging-port=0` and read back what Chromium chose. No
  allocation, no scanning, no collision — the process that chooses the
  port is the one that holds it.
- **One profile, one browser, one port.** Chromium enforces a singleton
  per `--user-data-dir`, so a second launch against a live profile
  signals the first and exits. This is a constraint, not a choice: it
  makes `DevToolsActivePort` unambiguous, and it means there is no
  "launch a second one" option to offer. Multiple *sessions* on one
  browser remain available — that is `cdpTab`, not a second launch.
- **Parallel sessions on one browser are allowed, and the author owns
  the consequences.** Signing in once and fanning several tests across
  that profile is the payoff for having a persistent profile at all,
  not an accident to prevent. The framework cannot tell a test that
  *consumes* the shared session from one that *mutates* it — only the
  author can. So no per-port serialisation and no tab-collision guard;
  instead, §11 makes what happened observable. `session_id` remains the
  concurrency control it already is: distinct ids run in parallel, a
  shared id queues on the existing mutex.
  **Consequence to state plainly:** tests sharing a profile are not
  independent, sequentially or concurrently. A test that logs out
  affects the next one to run. Suites needing isolation belong in
  default launch mode, which gives every test a fresh browser — that is
  what it is for.
- **The agent may drive owned browsers; anything else needs a config
  opt-in** (§6). Listing still *reports* foreign browsers — seeing is
  not attaching — but withholds their tab titles and URLs.
- **Headed, always.** A headless browser cannot be signed into by hand,
  which is the one thing this profile exists for.
- **No session pre-creation.** `start_cdp_browser` returns a port; the
  first `run_steps`/`run_test_file` carrying it creates the session and
  returns its id. The server accepts `config` only on the
  session-creating request, which is exactly this shape — and
  `POST /sessions/:id/steps` 400s on empty steps, so eager creation
  would need yet another route.
- **`cdp` in a test file's `## Config` is unchanged.** That path is
  human-authored and already trusted; §6's gate applies only to the
  **MCP tool argument**.

## Design

### 1. Profile layout

```
<project_root>/.steptix/cdp-profiles/<engine>-<profile>/
```

**Always `<engine>-<name>`**, with the default name `default` — one
rule rather than "bare dir for the default, suffixed for the rest",
which keeps registry enumeration to a single pattern (split on the
first hyphen; engine names contain none).

**Named profiles are required, not a nicety.** One profile per engine
cannot express:

- **different users** — admin vs regular, for permission tests;
- **different environments** — a uat login and a prod login side by
  side;
- **a deliberately signed-out profile**, which is the only way to test a
  sign-in flow at all.

They are also what makes "start a *new* browser" coherent. With a
single profile per engine there is nothing a second launch could do —
the singleton lock (§Locked) forbids a second process on one profile,
so `start_cdp_browser` can only ever return the existing browser. A
different profile is a different process and therefore its own
OS-assigned port; the singleton constraint is per-profile, not global,
so several browsers coexist.

**The name is a path component, so it is validated like one**:
`/^[A-Za-z0-9._-]+$/` — the same rule
[mcp-server.md](mcp-server.md) §4a rule 6 applies to `env_name`, and
for the same reason. Without it `profile: '../../../..'` puts a browser
profile, and later a recursive delete (§12), somewhere else entirely.

`mkdirSync(dir, {recursive:true})` at launch. Whether the directory
existed **before** that call is what separates
`launched_into_new_profile` from `launched_into_existing_profile` (§4),
so it must be read first. **Write a marker file `.steptix-profile` into
every profile at creation** — §12 refuses to delete any directory that
lacks it, so a reset can never remove a directory this framework did
not create.

### 2. Ownership, proved from disk

An MCP process is stateless across host restarts, the API server has a
60-minute idle timeout, and the browser outlives both. Ownership must
therefore be recoverable from the filesystem alone.

**Chromium writes `<user-data-dir>/DevToolsActivePort` when launched
with `--remote-debugging-port`** — first line the port, second the
WebSocket path. Since we own the profile dir, that file is a claim any
process can read back with no bookkeeping.

```
knownProfiles(projectRoot) =
  for each <engine>-<name> dir under .steptix/cdp-profiles/:
    read DevToolsActivePort line 1 → port
    live  := port is reachable AND /json/version's engine matches <engine>
    emit { engine, profile: name, profileDir, live, port: live ? port : null }
```

The route (§4) maps `live` onto the `running` / `available` split; the
registry itself stays a flat list, because the gate (§6) and `reset`
(§12) both need to ask "is this one profile live?" without reasoning
about which bucket it landed in.
```

**Dormant profiles are reported, not dropped** — as `available` rather
than `running` (§4). "This profile exists, nothing is running" and
"this is a stale port file" are the same bytes on disk, and the first
is useful: an agent told *"reuse an existing profile if there is one"*
can see that `admin` exists and start **that** rather than inventing
`admin2`. Reporting only live browsers would make that impossible and
drive profile sprawl (§Risks).

The **gate** (§6) is unaffected and stricter: attaching requires a
`running` entry — live, with a matching engine. An `available` profile
is something to launch, never something to attach to, and §4's split
lists are what make that impossible to confuse.

- **Self-cleaning.** A browser the user closed leaves a stale file, but
  the reachability probe drops it. No cleanup pass, no PID tracking.
  W0 found the file is **never** removed — not on an orderly exit, not
  on a crash — so the probe is not merely the cheapest cleanup, it is
  the only one.
- **Survives every restart** — server, MCP host, VS Code.
- **It proves the profile, not the process.** Anything that can write
  into `.steptix/cdp-profiles/` can forge a claim. That is the same trust
  boundary as `.env` and `steptix.config.json`, both already read without
  further proof, so it adds no new exposure. Stated so it is a
  decision.

> **W0 verified this — the story's single point of failure holds.**
> `DevToolsActivePort` was load-bearing twice (ownership proof *and*
> the only way to learn the port) with no fallback that preserves the
> design, so it was checked before anything was built. Measured on
> Windows 11, **Chrome 150.0.7871.187 and Edge 151.0.4129.59**, both
> engines identical:
>
> | Claim | Result |
> | --- | --- |
> | `--remote-debugging-port=0` writes `DevToolsActivePort` | yes, 260–1020 ms after spawn |
> | line 1 is the port actually listening | yes, and it is held by a process owning this profile |
> | line 2 is the `webSocketDebuggerUrl` path | yes, byte-identical to the `/json/version` suffix |
> | the file is deleted on orderly exit | **no** — always left stale |
> | the file survives a crash | yes, stale |
> | a stale port answers `/json/version` | no — the reachability probe drops it cleanly |
>
> The fixed-port fallback (9222, 9223, 9224 … skipping 9229, with a
> collision walk and a `.steptix/cdp-browsers.json` written at launch) is
> therefore **not needed**, and §7 does not regain the two error rows
> it would have carried. (The pre-W0 text pointed at §5 for those rows;
> errors are §7.)

**Engine identification is a prefix test on `/json/version`'s `Browser`
field**, which W0 confirms is unambiguous: Chrome reports
`Chrome/150.0.7871.187`, Edge reports `Edg/151.0.4129.59` — note
`Edg/`, not `Edge/`, and note that Edge does not put "Chrome" anywhere
in the string, so a `Chrome/` prefix cannot match an Edge browser.
flick's `classifyEngine` already does exactly this and W1 ports it (§9).

### 3. Ports — the browser picks, we read it back

There is no allocator. Launch is:

1. **This profile is live** (§2) → return it, no spawn.
   `outcome: 'reused_running_browser'`. A repeated "start Edge" returns
   the same browser instead of stacking them — which the singleton
   constraint would prevent anyway, but returning the live one is the
   useful answer rather than an error.
2. Otherwise → **delete any stale `DevToolsActivePort`** (safe only on
   this branch — see below), spawn with `--remote-debugging-port=0`,
   poll for the file, read line 1, confirm the port answers
   `/json/version`. That port is the result, and `outcome` is
   `launched_into_new_profile`, `launched_into_existing_profile` or
   `launched_after_reset` according to what §1 found on disk before
   `mkdirSync`.

**Both halves of that poll are required — W0 measured the gap.** The
file appears **before** the port serves HTTP, by 212–224 ms on Chrome
and 263–321 ms on Edge across four launches. A readiness check that
stops at "the file exists" hands back a port that is not listening yet,
and the caller's first `connectOverCDP` fails on a browser that was
fine. Wait for the file to learn the number, then poll the number to
learn it is ready.

**Why 0 rather than a free-port search.** The usual recipe — bind 0,
read the number, close, hand it to the child — races: between the close
and the child's bind, anything can take the port. Passing 0 *to the
child* has no such window. Collision is not mitigated, it is
impossible.

**The stale-delete is branch-scoped and that matters.** Deleting
`DevToolsActivePort` while a browser is alive on that profile destroys
the registry entry for a running browser — we would lose a signed-in
browser we still own. The delete happens only after step 1 has
established that nothing is alive. Conversely, skipping the delete
means a stale file from a crashed browser is read as current, and the
probe either fails confusingly or succeeds against a *different* live
browser. Both directions are bad; the ordering is the fix.

**W0 measured the window the delete closes, and it is not theoretical.**
After a relaunch the stale file keeps serving the **previous** port for
289 ms (Chrome) / 310 ms (Edge) before Chromium overwrites it. Every
relaunch takes a *different* port — 34510 → 16629, 55355 → 56499 — so
the stale value is never harmlessly right. The W0 harness itself fell
into this exact trap on its first run: it polled for the file, got the
old port back, and reported a healthy browser as unreachable. That is
the bug this ordering prevents, observed rather than predicted.

**The singleton lock behaves as §Locked assumes** — verified on both
engines. A second launch against a live profile exits without becoming
a browser, takes no port of its own, leaves `DevToolsActivePort`
byte-identical, and leaves the original port live; exactly one DevTools
port is listening under the profile throughout. The stale-delete
ordering can therefore rely on it.

One observable worth knowing: that second launch is not a no-op to the
*user* — it opens a new window in the existing browser, and the tab
shows up in `/json/list` (Chrome 1 → 2 tabs, Edge 2 → 3). Step 1 means
we never spawn against a live profile, so the framework does not cause
this; but it is one way a tab nobody's test opened can appear in a
session's view (§11). Also note Edge opens **two** tabs on a fresh
profile where Chrome opens one — nothing should assume a new browser
has exactly one tab.

**The cost is unguessable ports**, which is why §2's registry is not
optional. Nothing finds these browsers by scanning — not flick, not
`curl localhost:9222`, not a human. That is the correct trade (a fact
beats a guess) but it means the registry must be reachable by everyone
who needs it, which is what §4 is for.

### 4. Server routes

Both behind the existing auth middleware, so both bump the idle monitor
— fine, because no client polls them (flick's own locked decision 3 is
refresh-on-open plus a manual button, never polling). A polling client
would silently defeat the idle timeout, the way
[idle-monitor.ts:10](../src/server/idle-monitor.ts:10) explains
`/health` was kept pre-auth to avoid.

```
GET /cdp/browsers?projectRoot=<abs>&includeForeign=<bool>
  → { running:   [ { engine, profile, port, profileDir,
                     tabs: [{ targetId, title, url }] } ],
      available: [ { engine, profile, profileDir } ],
      foreign:   [ { engine, port, tabs: […] | null,
                     tabsWithheld, error } ] }

POST /cdp/browsers
  { projectRoot, engine: 'chrome' | 'edge',
    profile?: string,        // default "default"; §1's charset rule
    reset?: boolean }        // §12 — destructive, guarded
  → { engine, profile, port, profileDir, binary, tabs,
      outcome: 'reused_running_browser'
             | 'launched_into_existing_profile'
             | 'launched_into_new_profile'
             | 'launched_after_reset',
      warnings: string[] }
```

**Three lists, not one, because membership carries the meaning.** An
earlier draft returned a single `browsers` array holding running
browsers, dormant profiles and foreign browsers, distinguished by
`reachable`, `port: null`, `owner` and `tabsWithheld`. That required a
reader — human or model — to join four fields to work out what it was
looking at, and the obvious misreading of `browsers: [3 items]` is
"three browsers are running" when two are folders on disk. Each list
here has exactly one meaning and one permitted action:

| List | What it is | What you can do |
| --- | --- | --- |
| `running` | This project's live browsers | Attach: pass the port as `cdp` |
| `available` | This project's profiles with nothing running | Launch it by name |
| `foreign` | Browsers this project did not start | Nothing, without the §6 opt-in |

`foreign` is `[]` unless `includeForeign` was requested, and its `tabs`
stay `null` with `tabsWithheld: true` unless §6 permits them. This
also retires `owner` and `reachable` entirely — a browser's list
membership already says both.

**`outcome` is one enum, not four booleans.** An earlier draft returned
`launched`, `reused`, `profileIsNew` and `wasReset`: sixteen
combinations, roughly four of them valid, and two actively misleading.
`launched:true, reused:false` reads as "you got something fresh" when
launching into a profile that has held a signed-in session since last
week, and `profileIsNew` was specified as `true` after a reset — so the
name said "did not exist before" while the value meant "is empty". The
enum is mutually exclusive and each arm implies a different thing to
tell the user:

| `outcome` | What it means for what happens next |
| --- | --- |
| `reused_running_browser` | Already open. Tabs are wherever they were left. |
| `launched_into_existing_profile` | **May already be signed in, possibly as someone else.** |
| `launched_into_new_profile` | Empty. A human must sign in before tests will work. |
| `launched_after_reset` | Deliberately empty. A sign-in flow will be exercised. |

Row two is the dangerous one and the reason the booleans had to go: ask
for profile `admin` when it exists and you get it back silently, with
whatever session it was left holding. A permission test can then run as
the wrong user and pass for the wrong reason.

- **Owned browsers come from the registry, never from a scan** — their
  ports are OS-assigned and unguessable, so scanning could not find
  them.
- **`includeForeign` triggers the only port scan**, over the fixed list
  `[9222, 9223, 9229]` inherited from flick, since a browser we did not
  launch is by definition on a conventional port. `engine:'node'`
  entries are dropped: not attachable browsers, and 9229 is the Node
  `--inspect` default that this repo's own server lands on with
  `--inspect=0`.
- **Foreign tabs are withheld** — `tabs:null, tabsWithheld:true` —
  unless the caller is permitted them (§6). A foreign browser's open
  tabs may be someone's mail or bank, and for MCP callers that payload
  goes straight to a model provider.
- **`POST` is single-flighted per `(projectRoot, engine, profile)`.**
  Two clients racing both see "nothing alive", both spawn, and the
  loser hits the singleton lock and exits — leaving one client with a
  successful-looking spawn and no browser. Verification rule (6). Same
  shape as the auto-start single-flight in
  [mcp-server.md](mcp-server.md) §5. **The profile must be in the key**:
  two launches for different profiles are legitimately concurrent, and
  a key without it would serialise them for no reason — while a key
  without `engine` or `projectRoot` would let a reset (§12) run against
  a profile another call is launching.
- **No separate "profile is new" warning** — `outcome` carries it, and
  a warning duplicating an enum arm is a second source of truth that
  will drift. `warnings[]` is for things `outcome` cannot express: a
  failed trash cleanup after a reset, a `foreign` probe error, a tab
  list that could not be read.
- **No `DELETE`.** The browser is meant to outlive sessions and the
  user closes the window; `close_session` already ends the session. A
  close route is a reasonable follow-up for flick, not for this story.

`projectRoot` is caller-supplied, which is consistent with the existing
trust model — the server already accepts `testFilePath` from clients
and reads env, config, skills and tools relative to it. Noted rather
than solved; it is not a new boundary.

### 5. MCP tools

Thin HTTP clients of §4, like every other MCP tool. Bare names (the
host prefixes them, so a `steptix_` prefix would render as
`mcp__steptix__steptix_…`), zod `outputSchema`, every nullable field
explicit — `tabs`, `error`, `profileDir` are all nullable, and
[mcp-server.md](mcp-server.md) §2's rule that a missing required key is
fatal to `validateToolOutput` applies unchanged.

**Both names carry `cdp` deliberately.** The framework has two kinds of
browser — persistent CDP ones and per-session launch-mode ones — and a
bare `start_browser` / `list_browsers` would claim authority over both
while handling only the first. The prefix is wordier than it needs to
be for a reader who already knows the distinction, and exactly right
for a model that does not.

- **`list_cdp_browsers`** — `{ project_root? }` →
  `{ running, available, foreign }` (already an object, as
  `structuredContent` must be). Calls `GET /cdp/browsers`, passing
  `includeForeign` only when §6 permits.
  **Scoped to CDP, and the name says so.** A test running in default
  launch mode also has a browser, but it is a disposable side-effect of
  a session — no CDP port, driven over a pipe rather than TCP, gone
  when the session ends, and impossible to pass to `run_steps` as a
  `cdp` target. Those appear in `list_sessions`. A bare
  `list_browsers` would answer "what browsers do I have?" with half the
  truth and no hint that the other half exists, so **the description
  must name `list_sessions` as the complement** — the agent should
  call both when the question is open-ended.
- **`start_cdp_browser`** — `{ engine, profile?, reset?, project_root? }` →
  the `POST` response. **No `port` argument**: the caller cannot choose
  a port (§3), a browser we own is found by reuse, and one we do not
  own is reached via `list_cdp_browsers` + `run_steps` rather than by
  launching. **No `reuse` argument**: reuse is what `profile` selects —
  the same name returns the running browser, a new name starts a new
  one. The description must say that plainly, or an agent asked for "a
  new Chrome" will call with the default profile and be handed the old
  browser.
- **Run tools gain `cdp`.** `run_steps` and `run_test_file`'s `config`
  becomes `{ baseUrl?, timeout?, cdp? }` with
  `cdp: { port, tab? }`. `tab` takes the runner's existing selectors —
  `new` (default), an integer, `url~`, `title~`, `active`,
  `targetId:<id>`. Prefer `targetId:` and say so in the description:
  it is the only stable per-tab identifier
  ([flick-vscode-cdp-attach.md](flick-vscode-cdp-attach.md) row 2), and
  `list_cdp_browsers` hands them out.

**The descriptions are the interface.** Structure carries as much
meaning as it can — three lists, one enum — but the model reads prose
too, and [mcp-server.md](mcp-server.md) §7 already establishes the rule:
*behaviours go in tool descriptions because they surprise*. These
surprise:

- **Asking for a profile that exists reuses it silently.** There is no
  "already exists" error, because erroring would break the routine
  "start the admin browser" case. `outcome` says which happened, and
  the agent should relay it — *"`admin` already existed and may still
  be signed in"* is the answer to "create a new profile named admin",
  not silence.
- **A different profile name is how you get a different browser.**
  Without this, an agent asked for "a new Chrome" calls with the
  default profile and is handed the old one.
- **Reuse means inheriting whatever state was left behind** — a login,
  a logout, a half-finished form. `reset: true` is the clean-slate
  option and the only way to test a sign-in flow twice.
- **`available` entries are not browsers.** They are profiles with
  nothing running; launch one before sending steps to it.
- **Sessions on one browser share cookies** (§Locked). Parallel tests
  against one profile are supported and often what is wanted, but a
  test that signs out affects the others. Say it, so the agent can warn
  when a user's request implies it.

### 6. The gate

**The gate is MCP-side, not server-side.** The server cannot tell an
agent from a human — Steptix and flick are authenticated clients too,
and constraining them would be wrong. What needs constraining is an
*agent* choosing a browser, so the check lives where that choice is
made.

An agent-supplied `config.cdp` is accepted **iff its port belongs to a
`running` entry** for that project (§4). A port in `foreign` is
refused; a profile in `available` has no port to offer in the first
place. Otherwise: pre-flight error (§7) naming the port, where it was
found, and the opt-in.

```json
{ "mcp": { "cdp": { "allowUnowned": false, "ports": [9222, 9223] } } }
```

Read directly from the parsed `steptix.config.json` on the MCP path (the
loader is banned there, [mcp-server.md](mcp-server.md) §3).
`allowUnowned: true` permits attaching to any discovered browser and
un-withholds foreign tabs. `ports` overrides the foreign-scan list
only — nothing here influences what we launch on. Declare the shape in
[src/config/types.ts](../src/config/types.ts) for the rest of the
framework even though the MCP path reads raw.

**Why a config file rather than a tool argument.** The existing
precedent is `allow_foreign_session` — the right *shape*, the wrong
*gate* here. An agent sets its own boolean, so it stops accidents, not
a page that talks the agent into setting one; and behind this gate sits
a browser holding live sessions. `steptix.config.json` is the only gate a
human actually holds. `allow_foreign_session` is unchanged for
sessions; this is a second, stricter gate for browsers.

**Implementation trap.** [assemble.ts:453](../src/mcp/assemble.ts:453)
reads `cdp` from the **file's** config and never the merged map,
precisely so a schema change cannot admit an agent-supplied one. That
comment becomes wrong and must be **rewritten, not deleted**: the new
rule is *file config is trusted, tool config is gated*, and the two
sources must stay visibly distinct in the code.

### 7. Errors

MCP pre-flight rows for [src/mcp/errors.ts](../src/mcp/errors.ts) —
returned, never thrown, no TB codes
([mcp-server.md](mcp-server.md) §7). Server-side failures come back as
route errors and are surfaced with their text.

**Every message states three things: what was refused, why, and the
specific next action.** Not house decoration — an agent given
"permission denied" retries the same call or invents a workaround,
while one given "port 9222 is in `foreign`; use a profile from
`available`, or set `mcp.cdp.allowUnowned`" either fixes it or tells
the user exactly what it needs from them. The third column is
therefore part of the contract, not a nicety, and a message missing it
is an incomplete implementation.

| Condition | Message names | Next action it must offer |
| --- | --- | --- |
| `config.cdp` port is not a `running` entry | the port, which list it was found in (or that it was found nowhere), and `mcp.cdp.allowUnowned` | pick a browser from `running`; or launch the profile if it is in `available`; or set the opt-in |
| `config.cdp` port belongs to a profile now in `available` | the profile name, and that the browser has since been closed | `start_cdp_browser` with that profile — **it will return a new port and still be signed in**, which is the non-obvious part |
| engine not installed | the engine, the paths searched, and the copy-paste manual command (as the extension's error already does) | install it, or use the other engine |
| spawned but no `DevToolsActivePort` within budget | the profile dir, the pid, the budget — this is §3's mechanism failing, so the message must name the file rather than say "browser did not start" | retry; if it persists, the §3 mechanism is broken on this machine and that is worth reporting rather than working around |
| `DevToolsActivePort` present but the port does not answer | the port read from the file, and the last probe error | retry — a stale file from a crashed browser is the usual cause and the next launch clears it |
| profile dir not writable | the resolved dir | fix permissions on `.steptix/cdp-profiles/` |
| `profile` fails §1's charset rule | the value and the permitted characters | use a plain name — `admin`, `uat`, `signup-test` |
| `reset` while a browser is live on that profile | the profile, its port, and that it must be closed first | close that browser (or `close_session` if a run holds it), then retry |
| `reset` on a directory with no `.steptix-profile` marker | the resolved dir, and that the framework will not delete what it did not create | delete it by hand if that is genuinely intended — this refusal is not worked around in code |
| `reset` rename failed (files open / permissions) | the OS error, and that **nothing was deleted** — the atomicity guarantee is only useful if the message states it | close anything holding files in that profile, then retry; the profile is intact |
| `cdp.tab` matches no tab | the selector and the open tabs — the runner already produces this; surface it unchanged | pick one of the listed tabs, or use `tab: 'new'` |

Two of these carry information the caller is unlikely to guess and
which changes what they do next, so they are called out rather than
left to the implementer's phrasing:

- **A closed browser is not a lost browser.** The port dies with the
  process; the profile does not. Relaunching yields a *different* port
  and the same signed-in state. A message that only says "port not
  found" invites the conclusion that the login is gone.
- **`allowUnowned` is the only setting that widens an agent's reach**,
  and it lives in a file the agent cannot write. Naming it in the
  refusal is what lets the agent ask the user for it rather than
  silently failing or trying a different port.

### 8. Teardown, and issue 006

CDP teardown severs the WebSocket and **does not** close the browser
([cdp-connection.md:65](cdp-connection.md:65)). That is what makes
losing a session cheap: the window stays open and signed in, and
re-attaching costs one call. Verification rule (9) pins it.

**W0 verified this too, though it was not on its list.** The claim was
written when a CDP browser was the *user's* and losing it was merely
rude; this story makes the framework the owner of a browser holding a
hand-typed login, so a wrong claim here would destroy that login on
every run. On both engines: `browser.close()` on one connection leaves
the browser serving `/json/version`, leaves a second connection fully
usable, and — the case the original wording does not cover — the
browser survives **all** connections closing. Nothing about attaching
shortens the browser's life.

[issues/006](../issues/006-closeAll-doesnt-route-cdp-sessions-via-closeBrowser.md)
notes that `BrowserTracker.closeAll` calls `browser.close()` bluntly,
which on a CDP session would close the user's real browser. It was filed
*open / defensive* on the grounds that CDP sessions never enter the
tracker.

> **Amended during W7 — that premise did not hold, and 006 is now fixed
> rather than deferred.** Two things turned out differently:
>
> 1. **CDP sessions do enter the tracker**, and always did:
>    `new BrowserTracker(initialSession)` takes whatever the session is,
>    on both paths. What the CLI runner special-cases is only which
>    teardown *route* it takes — and
>    `SessionManager.closeSession` has no such special case, so it calls
>    `closeAll()` on CDP sessions every time. That is the path Steptix,
>    flick and MCP all use.
> 2. **The consequence was the opposite of the one feared.** Measured on
>    both engines: `context.close()` on a `connectOverCDP` default
>    context is a **no-op** — the browser stays up and every tab
>    survives, including the test's own — and `browser.close()` only
>    severs the socket. Nothing was ever destroyed. The real defect was a
>    **leak**: only `closeBrowser` knows about `cdpTabOpenedByUs`, so
>    going around it left the test's tab open on every run.
>
> The stakes argument still lands, just about a different failure. A
> stray blank tab per run is noise when CDP is a hand-written config
> line, and a browser filling with tabs once an agent drives it. Both
> `closeAll` and `close(label)` now route through `closeBrowser`, which
> is 006's own proposed fix and is byte-identical for non-CDP sessions.
>
> **The test this section originally called for could not be written** —
> "a CDP session never enters `BrowserTracker`" is not true. In its place
> [tests/cdp-teardown-invariant.test.ts](../tests/cdp-teardown-invariant.test.ts)
> pins the invariant that claim was standing in for: whichever teardown
> route runs, a CDP browser's context is never closed, the test's own tab
> is, a pre-existing tab is not, and non-CDP teardown is unchanged.

### 9. What ports from flick-vscode

Into `src/browser/cdp-launcher.ts` and `src/browser/cdp-discovery.ts`:

- *Port near-verbatim*: `detectInstalled` and its per-OS resolution
  order, the array-form spawn, `discoverCdpPorts`/`probePort`,
  `classifyEngine` (including the `node.js/` arm), the `type:'page'` +
  `devtools://`/`chrome-extension://` filtering, and the per-port error
  capture that never throws.
- *Change on the way*: the profile dir moves to §1's path;
  `LauncherDeps` injection stays (the tests need it, and so will the
  route tests); error strings lose their VS Code phrasing ("re-open the
  dropdown", "try the dropdown ⟳ button").
- **The readiness poll inverts, and gains a second half.** The
  extension polls `/json/version` on a port it already knows. With port
  0 we do not know the port yet, so it is **file-first**: wait for
  `DevToolsActivePort`, read line 1, *then* probe that port — both
  halves, because W0 found the file lands 212–321 ms before the port
  answers (§3). Keep the 5 s total budget: W0 saw the port answering
  473–1344 ms after spawn, so it has real headroom but not so much
  that it can be cut — and those were warm launches into a
  freshly-created profile, which is the fast case. Poll the **file**
  faster than 200 ms, though: at a 200 ms interval the file poll alone
  can burn most of the ~200–320 ms gap it exists to detect. W0 used
  50 ms for the file and 100 ms for the port.
- *Do NOT port*: anything touching `vscode.*`, `lastLaunched`
  persistence, or the split-button installed-browser logic.

Spawn flags stay as the extension has them — `--user-data-dir`,
`--no-first-run`, `--no-default-browser-check` — with
`--remote-debugging-port=0` per §3. **Array form is mandatory**; string
concat is a command-injection vector once `profileDir` can contain
spaces.

One optional flag joined them later (2026-08-23):
`--disable-blink-features=AutomationControlled`, behind
`browser.cdp.hideAutomation` in `steptix.config.json` (default `false`).
Measured on Chrome 151: `--remote-debugging-port` on its own makes every
page read `navigator.webdriver === true`, with nothing attached — the same
profile without the port flag reads `false` — and some sites refuse a
browser that says so, which defeats a browser a human signs into by hand.
The flag turns it back off at the cost of Chrome's yellow "unsupported
command-line flag" bar on launch. It is a config setting and not a tool
argument for the same reason `mcp.cdp` is: whether a browser stops
announcing itself is a human's decision, and an agent cannot write the
config file. The server reads the file of the root the launch goes into
(the project's, or the user root's for a machine-wide browser) — exactly
there, no walk-up — and records the choice in the profile's
`.steptix-profile` marker, so a later `reused_running_browser` can warn when
the running browser and the config disagree; the flag only applies at
launch.

### 10. Canonical copy, and flick

`src/browser/cdp-*.ts` is canonical. flick-vscode's copies are
**unmaintained pending a decision on flick's future** — not "frozen and
selectively back-ported", which would commit someone to syncing two
implementations of a component that may not need to exist.

**flick's convergence path is `GET /cdp/browsers`**, which it can call
through its existing `api-client.ts`. It must **not** read the registry
files directly: that would be a third implementation of ownership after
`src/browser/` and the extension's own discovery. **The registry is an
implementation detail; the route is the interface.** Converging retires
the extension's `cdp-discovery.ts` outright rather than syncing it.

Doing that conversion is out of scope here, but note it in both files:
after this story, flick's fixed port scan cannot see a
framework-launched browser at all.

### 11. Tab observability

Parallel sessions on one CDP browser are **allowed** (§Locked), so the
framework's job is not to prevent tab interference but to make it
visible. A test author who fans three tests across one signed-in
profile has accepted shared state; what they cannot accept is a
failure with no way to see which tab a step actually touched.

**The problem this solves.** [manager.ts:939](../src/browser/manager.ts:939)
snapshots the tabs open at attach and ignores them, then
[manager.ts:966](../src/browser/manager.ts:966) subscribes to
`context.on('page')` and adopts everything that appears afterwards. Two
sessions attached to one browser take the same underlying context, so a
tab opened by session A is expected to surface in session B's handler
too — B adopts a tab nothing in B opened.

**W0 confirms it, on both engines.** Two `connectOverCDP` connections
to one browser each see one context and the same page set. A
`context.newPage()` on A fires B's `context.on('page')`, lands in B's
`context.pages()`, and when A closes that page B's `page.on('close')`
fires too. There is no isolation to lean on: **every tab any session
opens is adopted by every other session on that browser.**

That is the permissive answer, and it settles the open question W0 was
asked: §11's unexpected-tab flag is a **common diagnostic, not a rare
one**. Any two tests run in parallel against one profile will trip it
as a matter of course, so the flag must read as information rather than
alarm, and the README warning (§Risks) is not a footnote — it is the
thing an author needs to read before fanning tests across a profile.

**Surface 1 — every step result carries its tab.**

```json
{ "index": 4, "text": "Click Checkout", "status": "passed",
  "tab": { "label": "page 2", "targetId": "AB12…",
           "url": "https://shop/cart", "title": "Cart" } }
```

`PageTracker` already assigns the label
([manager.ts:888](../src/browser/manager.ts:888)); it simply never
reaches the result. **`targetId` is the load-bearing field**, not the
label: labels are per-session, so two parallel sessions will both have
a "page 2" and only the target id distinguishes them.

**Resolve the target id once per page, at adopt time, and cache it on
the tracked page.** It is obtainable today — `resolveCdpTab`'s
`targetId:` arm reads it at
[manager.ts:691](../src/browser/manager.ts:691) — but via
`context.newCDPSession(page)` and `Target.getTargetInfo`, which is a
CDP round-trip. Doing that per step would add one to **every step of
every run**, in launch mode as well as CDP, to populate a diagnostic
field. `PageTracker` already stores per-page records with a `label`
([manager.ts:325](../src/browser/manager.ts:325)), so the id belongs
alongside it, resolved in `addPage`.

**The wire change is additive.** `RunEvent`'s `step:start`/`step:pass`/
`step:fail` carry `line` and an optional `frame` today
([session-manager.ts:281](../src/server/session-manager.ts:281)); `tab`
is a new optional field on the same three. Safe for existing consumers:
the MCP client validates only `line` and `frame` shape and ignores
extra keys, and unknown *event types* are already dropped rather than
fatal. Steptix and flick consume the same stream and are unaffected
by an optional addition.

Flows to the MCP step payload (a new field alongside `frameKind`,
`text`, `status` in [mcp-server.md](mcp-server.md) §2's shape), the
report, and the per-step log line.

**Surface 2 — the report.** Three things, in descending value:

- **A tab badge per step** — label plus a short target id, so a run can
  be scanned for where focus moved.
- **A tab timeline for the run** — which tabs this session touched,
  when each entered, and how: *attached at start*, *opened by step 7*,
  *appeared during step 12*.
- **A flag on tabs that appeared unexpectedly** — adopted mid-run, with
  no opener in this session, and not requested by any step. That is the
  cross-contamination case, and naming it in the report turns a
  baffling failure into a one-line diagnosis.

**Attribution is for diagnostics, never enforcement.** The unexpected
flag uses `page.opener()` to trace a new tab back to the page that
spawned it. An earlier draft proposed the same mechanism as a *guard*
that would refuse a colliding tab; that is rejected. A wrong heuristic
in a report is a misleading note; a wrong heuristic in a guard breaks a
legitimate test. It also avoids the atomic claim-and-check that a guard
would need, which the codebase does not cleanly have — session lookup
and creation run outside `queueTail`
([mcp-server.md](mcp-server.md) §6's accepted limitation).

*The report renderer has not been read.* The per-step badge is
near-certainly cheap; the timeline may not be. Confirm before
committing to it, and ship the badge and the flag regardless.

**Surface 3 — logs, deferred.** Per-step and tab-adoption log lines
want a session prefix to be worth anything: three sessions in one
browser produce interleaved output with nothing distinguishing them,
and the logger is process-global — the same root cause as
[mcp-server.md](mcp-server.md) §2's admission that `messages[]` may
carry another session's lines. Threading session identity through the
logger is a larger change than this story, and surfaces 1 and 2 already
carry the diagnostic weight because step results are per-session by
construction. Named as the follow-up, not built.

### 12. Profile reset

**What it is for.** A profile can accumulate state but never shed it.
Test a sign-in flow once and the profile is signed in; the next run
skips the login page entirely and the test either fails on a missing
element or — worse — passes without exercising a login. Without a
reset, that test works exactly once and thereafter needs a human
deleting a directory in Explorer. `reset: true` deletes the profile
before launching, so the run starts genuinely empty.

**This is the only destructive operation in the design**, so it is
specified in more detail than its size suggests.

**Order of operations**, every step load-bearing:

1. **Validate the name** against §1's charset. Rejects separators and
   `..` before any path is built.
2. **Resolve, then `realpath` both the profile dir and the
   `cdp-profiles` root, and compare on segment boundaries** — the §4a
   rules from [mcp-server.md](mcp-server.md), applied here because
   `path.resolve` does not follow symlinks. Without the realpath, a
   symlink at `.steptix/cdp-profiles/edge-admin` pointing anywhere on disk
   turns a reset into a recursive delete of the target.
3. **Require exactly one level below the root.** The resolved dir must
   be a direct child of `cdp-profiles`, never the root itself and never
   deeper.
4. **Require the `.steptix-profile` marker** (§1) inside it. This is the
   guard that does not depend on getting path logic right: a directory
   without the marker is not one we created, and is never deleted
   whatever the path check concluded.
5. **Refuse if the browser is live** — `live` for that profile in §2's
   terms. Deleting under a running browser pulls the floor out from a
   live session. The error names the port so the caller can close it.
6. **Rename, then delete.** `fs.rename` the profile to
   `.steptix/cdp-profiles/.trash-<engine>-<name>-<n>`, then remove the
   renamed directory best-effort. Rename on one filesystem is atomic,
   so the real path is either wholly present or wholly gone — **never
   half-deleted**, which a direct recursive delete can leave behind on
   any error and which would produce a corrupt profile that still looks
   launchable. A failed `rm` of the trash dir is a warning, not an
   error; a failed *rename* aborts with nothing touched.
7. **Launch as normal**, reporting
   `outcome: 'launched_after_reset'` and recreating the
   `.steptix-profile` marker.

**Windows will refuse a rename while files are open**, which is a
useful backstop for the case step 5 cannot see — a browser process
alive but its debugging port dead. It fails loudly with the OS error
rather than corrupting the profile.

**The residual is a TOCTOU**, the same class as
[issues/039](../issues/039-toctou-between-confinement-check-and-read.md):
a symlink swapped between the check and the rename is followed. The
marker check narrows it (the attacker must also plant a marker) and the
single-flight key (§4) closes the same-server race. Recorded rather
than solved, consistent with how 039 is already handled.

## Out of scope

- Converting flick to the new routes (§10), and any change to the
  Steptix extensions or `runner-core`.
- Using the user's real browser profile. Unchanged from
  [flick-vscode-cdp-attach.md](flick-vscode-cdp-attach.md), now locked
  here too.
- `DELETE /cdp/browsers` and a `stop_browser` tool (§4).
- **Pruning unused profiles.** `reset` empties a named profile; nothing
  removes one wholesale. Profiles are large and permanent, so a prune
  is a real follow-up (§Risks), just not this story.
- **Preventing tab collisions between parallel sessions.** Explicitly
  rejected, not deferred: no per-port serialisation, and no claim
  registry refusing a tab another session holds. Authors get
  observability (§11) and make their own calls.
- **Session-scoped logging** (§11 surface 3) — needs session identity
  threaded through a process-global logger.
- **`PageTracker` opener-based filtering** as *enforcement*. The same
  mechanism is used for the report's unexpected-tab flag, where being
  wrong is harmless.
- Fixing [issues/006](../issues/006-closeAll-doesnt-route-cdp-sessions-via-closeBrowser.md)
  or [002](../issues/002-cdp-and-multi-browser-interaction.md).
- Headless CDP, non-loopback CDP hosts, one-click launch for
  Brave/Opera/Vivaldi/Arc (still discoverable as `engine:'unknown'`).
- A `cdp:` default in `steptix.config.json` for the CLI path — still
  future. `mcp.cdp.*` is MCP-only.

## Composition

- `src/browser/cdp-launcher.ts`, `src/browser/cdp-discovery.ts` — the
  §9 ports. No server or MCP awareness.
- `src/browser/cdp-registry.ts` — profile paths (§1), ownership (§2),
  launch-or-reuse (§3). Takes a project root, returns browsers. The
  module both the route and any future client sits on.
- `src/server/api-server.ts` — the two §4 routes, single-flight,
  withholding.
- `src/mcp/cdp.ts` — the §6 gate and the mapping from route responses
  to tool payloads.
- `src/mcp/tools.ts`, `schemas.ts`, `errors.ts` — the two new tools.
- `src/mcp/api-client.ts` — `getCdpBrowsers` / `postCdpBrowser`.
- `src/mcp/assemble.ts` — the gated `cdp` projection (§6).
- `src/config/types.ts` — declare `mcp.cdp`.
- `src/browser/manager.ts`, the step event payload,
  `src/mcp/run-fold.ts` and the report renderer — §11's `tab` field and
  the report surfaces. Independent of everything above.

## Tests

House pattern per [mcp-server.md](mcp-server.md) §Tests: no
`supertest`, `listenOnRandomPort()` over `node:http`, and note
`tsconfig.json` excludes `tests` so `npm run lint` does not typecheck
them.

### Unit

- **Ownership**: `DevToolsActivePort` naming a reachable
  matching-engine port ⇒ owned; stale file, port dead ⇒ not owned, not
  returned; port reachable, engine mismatched ⇒ not owned; missing
  file ⇒ not owned; malformed ⇒ not owned, no throw.
- **Launch-or-reuse**: owned+live ⇒ reuse, and **the spawn stub is
  never called**; nothing owned ⇒ spawn asserted to carry
  `--remote-debugging-port=0`, never a literal; **stale file deleted
  before spawn, and NOT deleted on the reuse branch** (§3 — a delete
  against a live browser loses a signed-in browser, and a stale read
  can hit a different live one; both directions get a test); file never
  appears ⇒ the §7 error naming the file.
- **Launcher**: array-form spawn asserted (injection regression guard,
  as the extension's suite does); binary-missing error carries the
  manual command; file-first poll timeout message.
- **Named profiles**: `edge` + `admin` resolves to
  `cdp-profiles/edge-admin`; two profiles of one engine run
  simultaneously on **different ports**; a dormant profile lands in
  `available` and is **not** attachable through the gate; `profile`
  with a separator, a `..`, or an empty string is refused.
- **`outcome` correctness**: launching into a directory that already
  existed reports `launched_into_existing_profile`, **not**
  `launched_into_new_profile` — the distinction the removed booleans
  got wrong, and the one that decides whether the agent warns about an
  inherited session.
- **Error messages carry their next action** (§7 column 3). One
  assertion per row that the remediation text is present — cheap, and
  it is the column most likely to be dropped as decorative by an
  implementer working from the condition alone. The
  closed-browser-relaunches-signed-in row is asserted explicitly, since
  it is the one whose absence produces a *wrong* conclusion rather than
  merely an unhelpful one.
- **Reset** — one test per guard, since each closes a different hole:
  live browser ⇒ refused; missing `.steptix-profile` marker ⇒ refused
  (**even when the path check passes** — assert this against a
  legitimate-looking dir inside `cdp-profiles`); a symlinked profile
  dir pointing outside ⇒ refused, and the **target still exists**
  afterwards; the root itself ⇒ refused; a failed rename ⇒ the profile
  is **fully intact**, not partially deleted; success ⇒ marker
  recreated and `outcome: 'launched_after_reset'`.

### Route (real app over HTTP)

- `GET` puts live project browsers in `running`, dormant profiles in
  `available` **with no port field to attach to**, and foreign browsers
  in `foreign` — which is `[]` without `includeForeign`, and whose
  `tabs` are `null` with `tabsWithheld:true`. `engine:'node'` never
  appears in any list.
- **A dormant profile never appears in `running`**, and a foreign
  browser never does either. These are the two mistakes the split
  exists to prevent, so they are asserted directly rather than inferred
  from field values.
- `POST` returns each `outcome` arm: new profile, existing profile,
  reused running browser, and after a reset — **four tests, one per
  arm**, since the arm is what the agent tells the user and a wrong one
  is a silent lie about sign-in state.
- **Two concurrent `POST`s for the same `(projectRoot, engine)` produce
  one spawn** — verification rule (6).
- Both routes require auth and bump the idle monitor.

### MCP seam (`InMemoryTransport`)

- Both tools end to end against a faked client; `content[0]` text
  summary present; `isError` `toBeFalsy()` on success, not `false`.
- **Gate**: unowned port refused with the §7 message;
  `allowUnowned:true` permits; a **file** `## Config: cdp:` still works
  with no opt-in (the trusted path); file config wins over a tool-arg
  `cdp` on the same test.
- **Tracker invariant** (§8): a CDP session never enters
  `BrowserTracker`.

### Tab observability (§11)

- Every step result carries `tab` with a non-empty `targetId`, in both
  launch and CDP modes — a step that reports no tab is the bug this
  section exists to prevent.
- A step that switches tabs reports the **new** tab, not the old one.
- Two sessions on one browser produce **the same `targetId`** for a
  shared tab and **different** ones for separate tabs — the assertion
  that labels alone cannot make, and the reason `targetId` is on the
  wire.
- A tab opened by a step is **not** flagged unexpected; one adopted
  with no opener and no requesting step **is**.
- The flag is advisory: a false positive changes no status, fails no
  step, and appears only in the report.

### Live (manual, required to merge)

See **§Acceptance criteria** below. Every row is run by hand; a green
unit suite is not a substitute and does not close this story.

## Acceptance criteria — live, by prompt

> **Status after W7: the mechanism is verified live; the agent's prose is
> not.** 79 live checks against real Chrome 150.0.7871.187 and real Edge
> 151.0.4129.59 on Windows 11, all passing, in three scripts:
>
> | Script | Covers | Result |
> | --- | --- | --- |
> | `acceptance-routes.mjs` | every §4 route behaviour against real browsers: both engines launch, OS-assigned ports, reuse, named profiles side by side, close→`available`→relaunch on a new port, all four `outcome` arms, reset and its refusals, the charset refusal, auth, foreign withholding, and three concurrent POSTs producing **one** browser (rule 6) | 44/44 |
> | `acceptance-mcp.mjs` | the two tools over a **real stdio transport** against `dist/`, the gate refusing port 9222 with its next action, and a real AI-driven `run_steps` in a CDP browser — which returned a real `targetId`, left the browser running (rule 9), and wrote a report carrying the tab badge (rule 10) | 30/30 |
> | `acceptance-host-restart.mjs` | rule 3, the one mocks cannot fake: two genuinely separate `node dist/index.js mcp` processes, the first fully exited, and the second finds the same browser on the same port | 5/5 |
>
> **What is NOT yet verified, and needs a human:**
>
> 1. **Rule 2's manual sign-in.** Signing into a real site by hand and
>    confirming a later run reuses that session. The plumbing either side
>    of it is verified; the sign-in itself is not something a script can do.
> 2. **Roughly a third of the rows below assert what the agent *says***,
>    not what the code returns — whether it reports a reused profile as
>    newly created, whether it warns before running interfering tests in
>    parallel, whether it relays a refusal instead of working around it.
>    Those are only visible when a human types a sentence and reads the
>    reply. The tool descriptions (§5) are where they get fixed, and
>    iterating on that wording against real prompts is the remaining work.
>
> The scripts live in `.steptix/w0/` (gitignored). They are not a substitute
> for the by-prompt rows below — they prove the machine does the right
> thing, not that the agent says the right thing.

**These are run manually, from a real agent host, against real Chrome
**and** real Edge on Windows, after the build is complete. Not
optional, not "covered by the unit tests", not deferred to a follow-up.
A row that cannot be made to pass is a defect in this spec or its
implementation — record it and fix it, do not reword the row to match
what the code does.**

Why by-prompt rather than by-function: everything else in §Tests
exercises the code directly, which cannot catch the failures that
matter most here — an agent that reads `outcome` wrongly, a tool
description that does not stop it attaching to the wrong browser, or a
refusal it works around instead of relaying. Those are only visible
when a human types a sentence and reads what comes back.

Record, per row and per engine: the actual MCP call the host made, the
result, and whether the agent's **prose to the user** matched it. The
last column is the one that fails silently.

### Getting a browser

| Prompt | Expected MCP call | Expected result |
| --- | --- | --- |
| "Start an Edge browser over CDP" | `start_cdp_browser {engine:'edge'}` | Headed Edge, OS-assigned port, profile `edge-default`, `outcome: launched_into_new_profile`. Agent tells the user to sign in |
| *(sign in by hand)* "Go to the orders page and check the latest one" | `run_steps {steps, config:{cdp:{port, tab:'new'}}}` | Runs in a new tab of the signed-in browser. Returns a `sessionId` |
| "Now filter by last month" | `run_steps {steps, session_id}` — **no `config`** | Continues in the same tab. A repeated `config` would be refused by the server |
| *(without closing anything)* "Start Edge again" | `start_cdp_browser {engine:'edge'}` | `outcome: reused_running_browser`, same port, nothing spawned |
| *(close the window)* "Start Edge again" | `start_cdp_browser {engine:'edge'}` | New process, **new port**, `outcome: launched_into_existing_profile`, **still signed in** |
| *(restart the MCP host entirely)* "Start Edge" | `start_cdp_browser {engine:'edge'}` | Finds the running browser again — ownership survived a host restart. This is the rule mocks cannot fake |

### Profiles

| Prompt | Expected MCP call | Expected result |
| --- | --- | --- |
| "Start Edge with a profile named admin" | `start_cdp_browser {engine:'edge', profile:'admin'}` | `.steptix/cdp-profiles/edge-admin/`, its **own** port, running alongside `default` |
| "Start Edge with profile admin" *(exists)* | same | **No error.** `outcome: launched_into_existing_profile`, and the agent says it already existed and may still be signed in |
| "Create a new Chrome CDP profile named admin" *(exists)* | `start_cdp_browser {engine:'chrome', profile:'admin'}` | Same as above. **Check the agent's wording** — it must not report this as newly created |
| "Create a new Chrome and open facebook.com" | `start_cdp_browser` with a **new** profile name, then `run_steps` | A genuinely new browser. If the agent reuses `default` and calls it new, that is a description failure |
| "Start Edge, reuse an existing profile if there is one" | `list_cdp_browsers` → `start_cdp_browser {profile:<one found>}` | Starts an existing profile rather than inventing a name |
| "Run the permission test as admin, then as a regular user" | two `start_cdp_browser` calls, two profiles | Two browsers, two ports, two logins, no interference |
| "Test the login flow from scratch" | `start_cdp_browser {profile:'signup', reset:true}` | Profile wiped, `outcome: launched_after_reset`, the login page actually appears |

### Seeing what is there

| Prompt | Expected MCP call | Expected result |
| --- | --- | --- |
| "What browsers do I have?" | `list_cdp_browsers` **and** `list_sessions` | Both are called. An answer covering only CDP browsers means the §5 description failed |
| "Is my admin browser still open?" | `list_cdp_browsers` | `admin` under `running` with a port, or under `available` with none |
| "What tabs are open?" | `list_cdp_browsers` | `tabs[]` per `running` entry, each with a `targetId` |

### Running tests

| Prompt | Expected MCP call | Expected result |
| --- | --- | --- |
| "Run tests/checkout.md against my signed-in Edge" | `run_test_file {path, config:{cdp:{port, tab:'new'}}}` | Runs in a new tab using the existing session |
| "Run all three checkout tests against my signed-in Edge" | 3 × `run_test_file`, parallel | All three run **concurrently** — different files, different session ids, nothing serialises. Each gets its own tab |
| "Run the login test and the logout test against my signed-in Edge" | same | Runs in parallel, and they **do** interfere. The agent should say so up front — a silent run here is a description failure, not a code one |
| "Run these two tests against the tab I already have open" | 2 × `run_test_file` with `tab:'targetId:…'` | Not prevented. Per-step `targetId` in both reports makes the collision visible afterwards |
| "Which tab did step 4 use?" | *(read the report)* | Every step shows `tab: {label, targetId, url, title}` |

### Refusals

Each must refuse **and** state the next action (§7). Check the agent
relays it rather than retrying or inventing a workaround.

| Prompt | Expected result |
| --- | --- |
| "Attach to the browser on port 9222" *(started by Steptix/flick)* | Refused before any HTTP call. Names the port, that it is `foreign`, and `mcp.cdp.allowUnowned` |
| Same, after setting `allowUnowned: true` | Allowed, and `foreign` tabs are no longer withheld |
| "Start Edge with profile `../../secrets`" | Refused on the charset rule, naming the permitted characters |
| "Reset the admin profile" *(browser open)* | Refused, naming the port to close |
| "Run steps on port \<a closed browser's port\>" | Refused — **and the agent relaunches the profile rather than concluding the login is lost** |
| "Start Edge" *(Edge not installed — test on a machine or PATH where it isn't)* | Refused, naming the paths searched and the manual command |
| "Run steps in the tab titled Invoices" *(no such tab)* | Refused, listing the tabs that are open |

## Risks / open

- ~~**`DevToolsActivePort` is unverified here and is the single point
  of failure**~~ — **closed by W0** (§2). Verified on Chrome 150 and
  Edge 151, Windows 11: the file is written, line 1 is the live port,
  and a stale file is dropped by the reachability probe. The
  fixed-port fallback is not needed. It remains a single point of
  failure in the sense that the design has no alternative — but it is
  now a *measured* one, on the two engines this story supports. A
  future Chromium could change it; the launch path failing loudly
  (§7's "browser did not become reachable") is the detection.
- **This is a real egress escalation, and it is the point.** An agent
  driving a signed-in browser can read everything that browser can
  reach, and per-step `output`/`captures` go to the model provider. The
  mitigation is *scope*, not prevention: the profile holds only what
  the user deliberately signed into for testing.
- **Prompt injection selects pages, not browsers.** §6 constrains which
  browser an agent may attach to, not where a page then sends it. The
  honest guidance, and it belongs in the README: treat the CDP profile
  as compromised-by-default and sign it into test accounts only.
- **Unguessable ports make failures look like nothing happened.** A
  registry bug presents as "no browsers" rather than a wrong answer,
  and nothing can be found by scanning. The README must say where to
  look.
- **Ownership is forgeable** by anything that can write into
  `.steptix/cdp-profiles/` — same boundary as `.env`, so no new exposure,
  but it is a claim rather than proof.
- **Parallel sessions cross-contaminate tabs** (§11) — **confirmed by
  W0**, not merely expected. Both sessions take the same underlying
  context, so every tab either opens is adopted by the other, and
  closes propagate too. Deliberately not prevented — the author owns
  this — but a multi-tab test run in parallel *will* adopt tabs it
  never opened, routinely rather than occasionally. §11's report flag
  is the mitigation, and W0's answer means the docs must say this
  plainly and up front rather than as a caveat.
- **Tests sharing a profile are not independent**, sequentially or
  concurrently: a test that signs out affects the next one to run.
  Inherent to a shared profile, not fixable by ordering. Default launch
  mode is the isolated alternative and the README must say so.
- **flick is blind to these browsers until it is converted** (§10).
- **Issue 006's blast radius grows** (§8) even though its invariant
  holds.
- **Profile sprawl.** Each profile is a full browser profile — hundreds
  of MB — persists forever, and nothing prunes it. An agent that
  invents a name per run will quietly fill the disk. Listing dormant
  profiles (§2) is the main mitigation, since it lets an agent reuse
  `admin` instead of creating `admin2`; a prune command is the
  follow-up.
- **`reset` is a recursive delete driven by a caller-supplied name**
  (§12). Five guards, but the honest summary is that the marker file is
  the one that holds if the path logic is wrong, and a TOCTOU remains
  ([issues/039](../issues/039-toctou-between-confinement-check-and-read.md)).
- **A profile is per-project**, so two checkouts each need their own
  sign-in. Deliberate (§1); worth a README line.
- **Windows detached spawn** — as the extension; the readiness poll is
  the detection.

---

# Plan

The spec is the contract. Where plan and code disagree, read the code
and update this doc.

## Workstream graph

**W0–W7 are built.** Every workstream below is complete, the suite is
green (104 files, 1774 tests), and 79 live checks pass against real
Chrome and Edge — see §Acceptance criteria for what those cover and for
the two things still needing a human.

```
W0 ✅ DONE — DevToolsActivePort, the singleton lock and cross-session
 │   tab events all verified on Chrome 150 + Edge 151, Windows 11.
 │   All three hold; no design change. Findings in §2, §3, §8, §9, §11.
 ▼
W1 — port cdp-launcher.ts + cdp-discovery.ts into src/browser/:      W6 — tab
 │   port-0 spawn, file-first readiness poll, VS Code phrasing out    │  observability
 ▼                                                                   │  (§11): step
W2 — src/browser/cdp-registry.ts: profiles (§1), ownership (§2),      │  `tab` field,
 │   launch-or-reuse (§3) incl. the branch-scoped stale delete        │  report badge
 ▼                                                                   │  + timeline
W3 — server routes (§4): GET + POST, single-flight, withholding,      │  + unexpected
 │   auth, route tests through the real app                           │  flag
 ├────────────────────────────┐                                      │
 ▼                            ▼                                      │
W4 — MCP: api-client,        W5 — assemble.ts gated cdp              │
 │   cdp.ts gate (§6),        │   projection; rewrite the            │
 │   tools, schemas, errors    │   fileOnly comment                   │
 └────────────┬───────────────┘                                      │
              ▼                                                      │
        W7 — seam tests, tracker invariant, docs,  ◄─────────────────┘
             issue 006 note, live smoke (both engines)
```

W4 and W5 are parallel — disjoint files, both depend only on W3.
**W6 is independent of the whole chain** — it is runner-side and
improves CLI and Steptix runs too, so it can start any time after W0
tells it what to surface, or ship separately if this story stalls.
PRs: **PR-1** = W1+W2+W3 (framework + routes, independently useful),
**PR-2** = W4+W5, **PR-3** = W6, **PR-4** = W7.

## Workstreams

### W0 — verify the mechanism ✅ DONE

No production code — three experiments whose output is a spec edit.
Run on Windows 11, **Chrome 150.0.7871.187** and **Edge
151.0.4129.59**. Scripts are under `.steptix/w0/` — gitignored, so they
live on the machine that ran them and are not part of the build; they
are cheap to rewrite from this section if a future Chromium makes it
worth re-checking. Both engines agreed on every result.

1. **`DevToolsActivePort`** — **holds.** Both engines write it; line 1
   is the port actually listening, held by a process owning the
   profile; line 2 matches `webSocketDebuggerUrl`. Recorded in §2 with
   the measurements. The fixed-port fallback is not needed and §7 does
   not regain its two rows.
2. **The singleton lock** — **holds.** The second launch exits, takes
   no port, leaves the file byte-identical, leaves the original live.
   §3's stale-delete ordering can rely on it. Recorded in §3.
3. **Cross-session tab events** — **yes, and freely.** Every tab any
   session opens is adopted by every other session on that browser;
   closes propagate too. So §11's unexpected-tab flag is a *common*
   diagnostic. Recorded in §11 and §Risks.

**Three findings the experiments were not looking for**, each now in
the spec because each would otherwise have been discovered as a bug:

- `DevToolsActivePort` is **never** deleted — not on orderly exit, not
  on a crash — and after a relaunch it serves the *previous* port for
  ~300 ms. The W0 harness itself misread a healthy browser as
  unreachable this way. This is what §3's branch-scoped delete
  prevents, now observed rather than predicted (§2, §3).
- The port file lands **212–321 ms before the port answers HTTP**, so
  the readiness poll needs both halves; waiting only for the file
  returns a port that is not listening yet (§3, §9).
- `browser.close()` on a CDP connection really does leave the browser
  running — including after *all* connections close. Not on the list,
  but this story makes the framework the owner of a hand-signed-in
  browser, so the cost of that claim being wrong changed (§8).

**No design change was required.** W1–W7 proceed as written.

### W1 — port launcher + discovery

`src/browser/cdp-launcher.ts`, `src/browser/cdp-discovery.ts`, tests.
The deltas from the extension's originals are §9's list.

### W2 — registry, profiles, reset

`src/browser/cdp-registry.ts`. Named profiles and the marker file (§1),
ownership including dormant profiles (§2), launch-or-reuse (§3), and
`reset` with its five guards (§12). Mostly pure functions over a
discovery result and a filesystem read, so unit-testable without a
browser.

Two subtle parts, both with dedicated tests: the **branch-scoped stale
delete** (never on the reuse branch), and **`reset`'s rename-then-delete
ordering**. `reset` is the only code in this story that removes a
user's files — review it on its own rather than as part of a larger
diff.

### W3 — server routes

`src/server/api-server.ts`, `src/config/types.ts`, route tests. The
single-flight and the withholding rule are the substance; the rest is
plumbing the registry. Ships independently of any MCP work, which is
why it shares PR-1.

### W4 — MCP client, gate, tools

`src/mcp/api-client.ts`, `cdp.ts`, `tools.ts`, `schemas.ts`,
`errors.ts`.

### W5 — assemble gate

`src/mcp/assemble.ts`. Small but the highest-risk diff in the story:
the file whose existing comment says this must never happen. Rewrite
the comment to state the new two-source rule.

### W6 — tab observability

`src/browser/manager.ts` (surface the `PageTracker` label and resolve
each page's `targetId`), the step event payload, the report renderer,
and `src/mcp/run-fold.ts` to carry `tab` through to the MCP result.
Independent of W1–W5 and useful on its own — CLI and Steptix runs get
the same diagnostics. **Read the report renderer before committing to
the timeline**; ship the per-step badge and the unexpected-tab flag
regardless.

### W7 — tests, docs, ship

Seam tests, the §8 tracker invariant, README (the sign-in-once model,
where to find a port, the parallel-sessions model and what it does not
guarantee, the compromised-by-default guidance), and the note on issue
006. **No extension version bump** — nothing under
`steptix-*`/`runner-core` is touched, and flick's originals are left
alone.

**Then run every row of §Acceptance criteria by hand, on both
engines.** This is the last task in the story and it is not optional.
Budget real time for it: it is ~35 prompts across two engines, several
need a manual sign-in, and two need the MCP host restarted. Record the
result per row.

Expect failures that no earlier workstream could have caught, because
roughly a third of the rows assert what the **agent says**, not what
the code returns — whether it reports a reused profile as newly
created, whether it warns before running interfering tests in parallel,
whether it relaunches a closed profile or concludes the login is gone.
Those are fixed in the tool **descriptions** (§5), and iterating on
description wording against real prompts is the work here. A row that
cannot be made to pass is a defect in the spec or the implementation —
fix it, or record it explicitly as an accepted limitation. **Do not
reword a row to match what the code happens to do.**

## Code review

1. Verify each workstream with `git diff` — ground truth.
2. Run `simplify` before review.
3. Reviewer agent on W2+W5: ownership and the gate are where a silent
   "everything is owned" bug hides, and W5 deliberately reverses an
   existing safety comment.
4. `security-review` before merge — §6's gate, the array-form spawn,
   the withholding rule, `projectRoot` handling on the new routes,
   confirmation that no path can pass the user's real profile as
   `--user-data-dir`, and **§12's delete path**: name validation,
   realpath confinement, the one-level-below rule, the marker
   requirement, and the live-browser refusal. A recursive delete driven
   by a caller-supplied string is the highest-risk line in this story.

## Repo gotchas (from project memory — real, previously hit)

- The running server executes `dist/` — server-side changes are not
  live until `npm run build` **and a server restart**. This story is
  mostly server-side, so that loop applies to nearly every change.
- Hosts run the MCP server from `dist/` too: rebuild before every live
  smoke.
- Root `npm test` occasionally fails ALL files at once (transient
  worker-pool crash, ~8 s, 0 tests). Re-run before believing it.
- Framework/server changes need **no** extension version bump.
