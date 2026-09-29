# Server lifecycle — auto-start from Steptix, health, stop, idle shutdown

> **Verification rule for this story.** "Done" means: (1) with no server
> running and `steptix.serverAutoStart.command` configured, hitting
> Run on a test in Steptix native starts the server in the background,
> waits for it to become healthy, and the test runs — no terminal involved;
> (2) the server keeps running after the test finishes and after VS Code is
> closed, and exits on its own after 60 minutes with no run in flight and no
> authenticated API traffic — closing any sessions/browsers still open;
> (3) `steptix status` prints running/not-running (exit code 0/1) plus version,
> uptime, session counts, and inspector state; (4) `steptix stop` stops a
> server that has no run in flight (closing idle sessions), refuses with a
> clear message while a run is executing, and `steptix stop --force` stops it
> anyway; (5) tool step-into still works against the auto-started server,
> attaching to the inspector port reported by `/health` (not the hardcoded
> settings), including when the server was started with `--inspect=0`. A VS
> Code integration test covering the auto-start path (spawn → health poll →
> run) is part of the contract.

## Context

Today the Steptix native extension is a pure HTTP client: it reads
`SERVER_URL` + `STEPTIX_SERVER_API_KEY` from the project's `.env.<name>` fixture and
calls the Sessions API. If the server isn't running, the run fails with
STX010 (connect-failed, mapped in
[run-controller.ts §mapApiErrorToPayload](../steptix-vscode/src/extension/run-controller.ts))
and the user has to switch to a terminal, start the server manually
(`node --env-file=templates/.env ... serve`), and come back.

The server itself ([src/server/api-server.ts](../src/server/api-server.ts))
has no health endpoint and no stop endpoint — every route sits behind the
`x-api-key` middleware, and the only way to stop it is Ctrl+C in the
terminal that owns it. There is also no way to ask "is it running?" other
than firing an authenticated API call and interpreting the failure.

Separately, tool step-into has a latent wrong-process bug: the extension
attaches VS Code's Node debugger to a hardcoded `inspectorPort` setting
(default 9229, [extension.ts §handleToolAwaitingDebugger](../steptix-vscode/src/extension/extension.ts)).
If another node process holds 9229, the server starts **without an
inspector** (node only warns), the extension attaches to the *other*
process's inspector, the ack releases the server, its `debugger;` is a
no-op, and the user's breakpoint silently never hits. This story fixes that
as a side effect of health reporting.

## Locked decisions

- **Idle timeout is the stop mechanism**, not VS Code lifecycle. Tying
  shutdown to "last VS Code window closed" requires cross-window ownership
  tracking and a reliable `deactivate()` — both fragile. Default 60
  minutes, only when `--idle-timeout` is passed; manual launches without
  the flag keep today's run-forever behaviour.
- **Idle means "no run in flight AND no authenticated request for N
  minutes"** — NOT "no open sessions". Interactive Steptix runs keep
  their session (and browser) open indefinitely for reuse, and sessions
  survive VS Code reloads by design, so a session-count-based definition
  would never fire. Open-but-idle sessions do not pin the server; the idle
  shutdown closes them (browsers included) on its way out.
- **Auto-start launch recipe is a VS Code setting** (command + cwd), not
  inferred. Unset ⇒ auto-start never fires, so the feature can't misfire
  against a remote `SERVER_URL` or on machines without the framework
  checkout.
- **Auto-start runs `dist/`**, not the tsx dev entry point. (User accepts
  the stale-build tradeoff; no build-on-start in the default command.)
- **The extension attaches the debugger to what `/health` reports**, and
  auto-start uses `--inspect=0` so inspector port conflicts cannot occur
  for auto-started servers. The `inspectorPort`/`inspectorHost` settings
  become a fallback for servers whose `/health` predates this story.
- **`steptix stop` refuses while a run is in flight** unless `--force`. Open
  sessions with no run executing do not block a stop — they are closed as
  part of it.
- **`/health` does not reset the idle timer** — otherwise the status bar's
  periodic poll would keep the server alive forever and the idle timeout
  would be dead code.

## Design

### 1. `GET /health` (server)

Registered in `createApiServer` **before** the auth middleware —
unauthenticated by design (localhost dev server; response carries nothing
sensitive). Response:

```json
{
  "ok": true,
  "service": "steptix",
  "version": "<package.json version>",
  "pid": 12345,
  "startedAt": "2026-07-23T10:00:00.000Z",
  "openSessions": 1,
  "runsInFlight": 0,
  "inspector": "ws://127.0.0.1:53012/9f3a-...",
  "idleTimeoutMinutes": 60
}
```

- `service` is the identity marker: it lets clients distinguish "our server
  on this port" from "something else grabbed the port". Clients MUST check
  it before treating the port as ours.
- `openSessions` = `SessionManager.getActiveSessions().length`;
  `runsInFlight` = sessions currently executing steps (needs a small
  SessionManager accessor — see §2).
- `inspector` is `require('node:inspector').url() ?? null` — ground truth
  from inside the process. `null` means step-into cannot work (started
  without `--inspect`, or the requested port was taken).
- `idleTimeoutMinutes` is `null` when no timeout is armed.
- Handler is synchronous and touches no session state beyond counts.

### 2. `POST /admin/shutdown` (server)

Behind the auth middleware. Body: `{ "force": true }` optional.

- A run is in flight (steps executing) and not `force` ⇒
  `409 { error, runsInFlight: n, openSessions: m }`. Open-but-idle
  sessions alone do NOT cause a 409.
- Otherwise ⇒ `200 { ok: true, stopping: true }`, then: stop accepting new
  work, close all sessions via the existing `SessionManager.closeAll()`
  (browsers included), `server.close()`, and `process.exit(0)` after a
  short grace delay (~250 ms) so the response flushes. A hard-exit fallback
  timer (~10 s) guards against a teardown that hangs.

**Wiring / test seam.** `createApiServer` builds the app but the HTTP
`server` handle and `process.exit` live in `startServer`. So:

- `createApiServer(config, hooks?)` gains an optional
  `hooks: { requestShutdown(force: boolean): void }` — the
  `/admin/shutdown` route validates (including the 409 check) and then
  calls `hooks.requestShutdown`; `startServer` supplies the real
  teardown+exit implementation. Tests supply a spy and assert it was
  invoked, exercising the route through the real app (house pattern,
  [tests/api-server.test.ts](../tests/api-server.test.ts)) with no exit
  stubbing gymnastics.
- The auth middleware bumps an activity timestamp owned by a small
  `IdleMonitor` object (see §3) that `createApiServer` accepts/creates and
  returns, so unit tests can drive it with fake time.
- `SessionManager` gains a `runsInFlight()` count (sessions currently
  inside step execution) alongside the existing `getActiveSessions()` /
  `closeAll()`.

### 3. Idle timeout (server)

- `serve --idle-timeout <minutes>`; also `config.server.idleTimeoutMinutes`
  declared **optional** on `ServerConfig` (no `defaults.ts` entry needed;
  `deepMerge` handles absence and the generated JSON schema picks it up on
  `npm run build:schema`). CLI flag wins. Absent/0 ⇒ disabled.
- "Idle" = **no run in flight AND no authenticated API request** for N
  minutes. Implementation: `IdleMonitor` holds `lastActivity`, bumped by
  the auth middleware on every authenticated request; a 30 s interval (in
  `startServer`) checks
  `runsInFlight() === 0 && now - lastActivity > N`. `/health` is
  unauthenticated and therefore never bumps it.
- On expiry: log one line (`idle for 60m — closing 2 session(s) and
  shutting down`) and run the same graceful teardown as §2 — open sessions
  and their browsers are closed by it.
- `runsInFlight()` is a **maintained counter** incremented/decremented
  around `executeSteps` — not a derived scan of per-session state — so
  `/health` stays a cheap synchronous read. Step-mode and tool-debugger
  pauses happen *inside* `executeSteps` and are therefore covered: a run
  paused mid-execution pins the timer.
- A run in flight pins the timer regardless of HTTP traffic, so a
  long-running test with no polling cannot be reaped mid-run. An open
  session that merely *exists* does not pin it — that's the point.
- **Breakpoint-pause keep-alive (extension).** The extension's
  *breakpoint* pause is client-side: the batch is truncated at the
  breakpoint, the server finishes it, and the session sits with no run in
  flight while the user is paused — invisible to `runsInFlight()`. So
  while any run controller is in the paused-at-breakpoint state, the
  extension sends a cheap authenticated keep-alive (`GET /sessions/:id`)
  every 5 minutes; that bumps `lastActivity` and pins the server under
  the idle definition with no server-side changes. The keep-alive stops
  when the run resumes, is stopped, or the controller is disposed.

### 4. CLI: `steptix status`, `steptix stop`

Both new commands resolve the target URL the same way: `--url <url>` flag
if given, else `http://<config.server.host>:<config.server.port>` from the
loaded config (same discovery as `serve`).

- **`steptix status [--url] [--json]`** — GET `/health` (2 s timeout).
  - Healthy + `service` matches: print version, pid, uptime, open
    sessions, runs in flight, inspector url or `none`, idle timeout.
    Exit 0.
  - Connection refused/timeout: `not running`. Exit 1.
  - Responds but wrong/absent `service` (or non-JSON): `port occupied by
    another process (or an older Steptix server without /health)`. Exit 2.
  - `--json` emits the raw health body (plus `{ running: false }` when
    down) for scripting.
- **`steptix stop [--url] [--force]`** — POST `/admin/shutdown` with
  `STEPTIX_SERVER_API_KEY` from the environment (same sourcing as `serve`; error
  out if unset). On 409, print runs-in-flight and open-session counts and
  suggest `--force`; the message explains that open Steptix sessions
  alone don't block a stop, only an executing run does. On 401, say the
  CLI's key (from cwd `./.env`) doesn't match the server's and name both
  sources. Exit 0 on accepted stop, 1 otherwise. After the 200, poll
  `/health` briefly to confirm the process actually went away and say so.

### 5. Extension: auto-start on Run

New settings (all under `steptix-vscode.`):

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `serverAutoStart.command` | string | `""` | Full shell command to launch the server. Empty ⇒ auto-start disabled. |
| `serverAutoStart.cwd` | string | `""` | Working directory for the command. **Required when `command` is set** — spawn is refused otherwise (see below). |
| `serverAutoStart.readyTimeoutSeconds` | number | `20` | How long to poll `/health` after spawning before giving up. |

`command` and `cwd` are declared with `"scope": "machine"` in
`contributes.configuration` — they can only be set in **user** settings,
never in a workspace's `.vscode/settings.json`. This is a security
requirement, not a convenience choice: the extension executes `command`
verbatim, so a workspace-settable value would let any cloned repo run
arbitrary code the moment the user hits Run. (Same rationale as VS Code's
own machine-scoped shell/tool-path settings.)

For the same reason, **`cwd` must be explicitly set when `command` is**:
the suggested command is cwd-relative (`dist/index.js`), so defaulting a
blank `cwd` to the open workspace folder would let a hostile repo control
*what the command resolves to* even though it can't set the settings —
opening a repo whose `SERVER_URL` points at a down localhost port would
execute that repo's `dist/index.js`. If `command` is set and `cwd` is
blank, the spawn is refused with the STX028 diagnostic
("serverAutoStart.cwd is not set").

Suggested value for this machine (docs + setting description):

```
node --inspect=0 --env-file=templates/.env dist/index.js serve --idle-timeout 60
```

with `cwd` = the framework checkout. `--inspect=0` lets node pick any free
inspector port (discovered via `/health`, §7); `--idle-timeout 60` arms the
self-stop only for auto-started servers.

A machine that has only the package installed (a test project depending on
`steptix`, no checkout) runs the same server as
`npx steptix serve --idle-timeout 60` with `cwd` = that project, or as
`node --inspect=0 node_modules/steptix/dist/index.js serve
--idle-timeout 60` to keep the inspector for step-into. The setting
descriptions carry both forms; `cwd` is "whichever the command is written
against", not "the checkout". Same for STX010's fix text, which names
`npx steptix serve` rather than a command that needs the repo
([issue 050](../issues/resolved/050-codebehind-compile-fetch-failed.md)).

Pre-run flow (in the run controller, after env resolution gives
`SERVER_URL`, before session creation). The run's `AbortController` is
created **before** this phase so the Stop button cancels a wedged health
wait/spawn poll — abort during this phase yields status `aborted`, not an
auto-start error:

1. `GET SERVER_URL/health`, ~1 s timeout.
2. **2xx JSON + `service` matches** ⇒ proceed; remember `inspector` for §7.
3. **2xx JSON but `service` mismatches** ⇒ fail the run with STX027
   ("SERVER_URL responds but is not a Steptix server"). Never
   spawn on top of a foreign process's port.
4. **Reachable but non-2xx or non-JSON** (e.g. an older Steptix server whose
   Express 404s `/health` — indistinguishable from a foreign server by
   this probe) ⇒ treat as "reachable, identity unknown": proceed with the
   run on the legacy path (settings-based inspector fallback, §7.4).
   Never spawn, never refuse. The subsequent authenticated calls sort out
   whether it's really our server (existing TB01x mapping).
5. **Down (connect-failed/timeout)**: if `SERVER_URL` host is not
   localhost, or `serverAutoStart.command` is unset ⇒ current behaviour
   (STX010), whose message gains a hint: "configure
   steptix.serverAutoStart to start it automatically".
6. **Down + localhost + configured** ⇒ spawn:
   - `child_process.spawn(command, { cwd, shell: true, detached: true,
     windowsHide: true, stdio: ['ignore', logFd, logFd] })`, then
     `unref()`. Detached so the server outlives VS Code (a locked
     requirement).
   - `logFd` appends to `<globalStorage>/server.log` (one rolling file;
     truncate when > 5 MB at open). A "Steptix: Show Server Log" command
     opens it.
   - Poll `/health` every 250 ms until `ok` + `service` match, up to
     `readyTimeoutSeconds`, respecting the run's abort signal. Then
     proceed with the run.
   - Timeout, or the child exits before health goes green ⇒ fail with
     STX028 ("server auto-start failed — see server log"), including the
     log's last lines in the diagnostic if cheaply available.
7. **Two-window race**: both windows pass step 5 and spawn; the loser's
   child fails to bind the port and dies (EADDRINUSE is unhandled in
   `startServer`, so the process exits). The loser's health poll then goes
   green anyway (the winner's server) — poll-until-healthy makes the race
   self-resolving; no locking needed. The dead child just leaves a line in
   the log.

**Error codes.** STX026 is taken (Monaco inline-sections refusal), so the
new codes are **STX027** (foreign service on SERVER_URL) and **STX028**
(auto-start failed). Both go into the runner-core error catalogue with
sample contexts carrying `serverUrl` verbatim (house pattern per the
SERVER_URL-audit test in
[runner-core/tests/errors.test.js](../runner-core/tests/errors.test.js)),
and need the runner-core `node --test` audit run.

**Health-probe seam.** The electron integration harness fakes the server
via `clientFactory`/`FakeApiClient`; a raw `fetch` in the run controller
would bypass it. The health probe is therefore constructor-injected into
`RunController` alongside `clientFactory` (same style as `pollSleep` /
`breakpointsByUriProvider`): `healthProbe?: (url: string, timeoutMs:
number, signal?: AbortSignal) => Promise<HealthResult>`, defaulting to the
real `fetch` implementation. Integration tests inject a scripted probe;
the spawn itself is injected similarly (`spawnServer?`) so tests can
substitute a tiny fixture script or a spy.

### 6. Extension: visibility + manual control

- **Status bar item**: `STEPTIX ⏵ 0.4.2` (running; open sessions / runs in
  flight on hover) / `STEPTIX ○` (stopped) / `STEPTIX ⚠` (unrecognized
  response). The ⚠ hover must not imply the port is foreign — per §5.4 it
  may be an older Steptix server without `/health`: "unrecognized response
  on SERVER_URL — may be an older Steptix server without /health; runs will
  still be attempted". Poll `/health` every 30 s and immediately after
  run start/end and Start/Stop commands. Health polling is free of
  idle-timer side effects (§3).
- **Poll target resolution.** There is no run in play, so the walk-up-from
  -test-file env resolution doesn't apply. The status bar (and the
  Start/Stop commands' URL + key sourcing) reads the **workspace root's**
  `.env` composed with `.env.<activeEnv>` overlay (the same overlay
  mechanism runs use; active env name from the existing env-selector).
  The item hides only when that composition yields no `SERVER_URL` —
  note the common case of no active env selected and `SERVER_URL` in the
  base `.env` must still show the item.
- **Commands** (palette + status-bar click menu):
  - `Steptix: Start Server` — same spawn+poll as §5.6, without a run.
  - `Steptix: Stop Server` — POST `/admin/shutdown` (key sourced as
    above). On 409, offer "Force stop" in the warning toast.
  - `Steptix: Server Status` — toast with the `/health` summary.
  - `Steptix: Show Server Log` — opens the §5 log file.
- **Force-stopping during this window's own run** tears the session down
  under the open SSE stream, which surfaces in the runner panel as STX014
  (stream-dropped). That's expected, not a bug; the Stop Server toast's
  force option says "the current run will fail with a dropped-stream
  error". No attempt to suppress the STX014 — the run genuinely died.

### 7. Extension: inspector discovery (fixes the wrong-process attach)

`handleToolAwaitingDebugger` currently attaches to
`settings.inspectorPort`/`inspectorHost`. New order:

1. The pre-run health check (§5.1) stored `health.inspector` on the run
   controller (run-scoped, like `currentServerUrl`).
2. `inspector` is a ws URL ⇒ parse host + port from it and attach.
   Normalize unconnectable bind addresses first: host `0.0.0.0` or `::`
   ⇒ `127.0.0.1` (a server launched with `--inspect=0.0.0.0:x` reports
   the bind address, which Windows can't dial).
3. `inspector` is `null` ⇒ do **not** attach blindly: ack-and-continue
   with a status-bar message "server has no inspector — restart it with
   --inspect to enable step-into" (mirrors today's degrade path, but now
   accurate instead of silently attaching to the wrong process).
4. Health had no `inspector` field / no health data (older server, §5.4
   legacy path) ⇒ fall back to the `inspectorPort`/`inspectorHost`
   settings, today's behaviour.

The `alreadyAttached` reuse check (`activeDebugSession?.type ===
'pwa-node'`) additionally compares the session's configured port to the
target port, so a user debugging some unrelated node process no longer
suppresses our attach.

### 8. Packaging / shipping

- Server + CLI changes (§1–4) live in `src/` — they ship via server
  restart and need **no** extension version bump.
- Extension changes (§5–7) bump the `steptix-vscode` patch version, per
  the standing rule; the `runner-core` change (STX027/STX028) is bundled
  into that same bump.
- `runner-core` is also bundled into `testbench-monaco`, but Monaco is
  deliberately **not** repackaged for this story: the new codes are never
  emitted by Monaco, so its stale bundled copy is harmless. (Noted here
  explicitly so the "bump the affected variant" rule isn't silently
  violated — the exception is intentional.)
- `/health` and `/admin/shutdown` are additive; Monaco keeps working
  against the same server.

## Out of scope

- Stopping the server when VS Code closes (idle timeout covers cleanup).
- Auto-start for remote `SERVER_URL`s, or provisioning the framework
  checkout / running `npm install` / `npm run build` from the extension.
- Build-freshness detection (dist mtime in `/health`) — user explicitly
  not worried about stale builds.
- Per-session TTL/expiry independent of server shutdown (the idle
  shutdown closes sessions; nothing expires them while the server stays
  up).
- Monaco-variant auto-start.
- Multi-server management (one `SERVER_URL` at a time per window).

## Tests

### Unit / seam (vitest, repo root)

Per the "test at the client seam" rule, exercise these through the real
`createApiServer` app (supertest-style, house pattern
[tests/api-server.test.ts](../tests/api-server.test.ts)), not resolver
units:

- `/health` responds without an api key; shape as §1; `openSessions` /
  `runsInFlight` reflect a live session; `inspector: null` when not under
  `--inspect`.
- `/health` does **not** bump the `IdleMonitor` timestamp; an
  authenticated request does.
- `/admin/shutdown`: 401 without key; 409 with a run in flight sans
  force; 200 + `requestShutdown` hook spy invoked when idle sessions are
  merely open; 200 + hook invoked with force during a run.
- `IdleMonitor` unit (fake time): fires only when `runsInFlight() === 0`
  AND stale; an in-flight run pins it; an open idle session does not;
  disabled when no flag/config.
- CLI `status`/`stop`: exit codes 0/1/2 against a stub server (running /
  down / foreign-or-legacy), 401 message naming both key sources.

### runner-core (`node --test`)

- STX027/STX028 catalogue entries + sample contexts carrying `serverUrl`;
  audit suite passes.

### Extension integration (electron harness, FakeApiClient + injected probe)

- Pre-run health probe (injected): healthy ⇒ no spawn; foreign service ⇒
  STX027; non-2xx/non-JSON ⇒ legacy path, no spawn, no refusal; down + no
  setting ⇒ STX010 with the new hint.
- Auto-start (injected spawn + scripted probe): down + configured ⇒ spawn
  invoked, probe flips healthy, run proceeds; probe never healthy ⇒ STX028
  within `readyTimeoutSeconds`; Stop during the poll ⇒ status `aborted`,
  no STX028; `command` set but `cwd` blank ⇒ STX028 ("cwd is not set"), no
  spawn attempted.
- Breakpoint-pause keep-alive: run paused at a breakpoint ⇒ periodic
  `GET /sessions/:id` observed on the (fake) client while paused; stops
  on resume/stop/dispose.
- Inspector discovery: health reporting a ws URL routes the attach config
  to that port (and `0.0.0.0` normalizes to `127.0.0.1`);
  `inspector: null` skips attach with the §7.3 message; no health data ⇒
  settings fallback.

### Live (manual or `test:live`)

- End-to-end on this machine: no server running → Run → server appears
  (Task Manager), test passes, VS Code closed, server still up, `steptix
  status` exit 0, `steptix stop` closes the open interactive session and
  stops, step-into lands in tool source with `--inspect=0`.
- Idle: server with an open session but no traffic and a short
  `--idle-timeout` exits on its own, closing the browser.

## Risks / open

- **Detached spawn on Windows + `shell: true`**: the detached child is the
  shell, and killing/`unref`-ing semantics differ from POSIX. We never
  kill the child (stop goes through HTTP), so this is only a risk for the
  "child died early" detection in §5.6 — detect via health-poll timeout
  rather than child `exit` events if the latter proves unreliable.
- **`--env-file` in the command**: the api key the *server* loads must
  match the `STEPTIX_SERVER_API_KEY` in the *project's* `.env.<name>` the
  extension sends. Mismatch ⇒ server starts healthy but the run gets 401
  (existing STX011 path). Same hazard CLI-side: `steptix stop` sources its key
  from cwd `./.env`, which can differ from the server's `templates/.env` —
  §4 defines the 401 message for this. Document in the setting
  description; no code beyond messages.
- **Status-bar poll target when multiple projects/envs point at different
  ports** — the item tracks the workspace-root composition only;
  acceptable for now.
- **`steptix stop` confirmation of exit** polls `/health` going dark; if the
  grace-delay exit ever hangs behind the 10 s fallback, `stop` may report
  "still stopping" — acceptable, message says so.
- **Two pause flavors, one server-visible.** Step-mode / tool-debugger
  pauses park *inside* `executeSteps` (the run awaits run-control), so the
  `runsInFlight` counter covers them naturally. The extension's
  *breakpoint* pause is client-side batching — the server finishes the
  truncated batch and sits with **no run in flight** while the user is
  paused. That state is invisible to any server counter, hence the §5
  keep-alive requirement; if the keep-alive ever fails silently, the
  worst case is the idle shutdown closing the session after N minutes and
  Resume failing with the existing stale-session handling.

# Plan

Written for the implementing agent/session. The spec above is the
contract; this section adds sequencing, file-level pointers, and repo
gotchas so nothing has to be re-derived. Do not trust this plan over the
code — where they disagree, read the code and update this doc.

## Workstream graph

```
W1 — server core (/health, shutdown, IdleMonitor, runsInFlight)
 │
 ├────────────► W2 — CLI status/stop        (needs W1's /health shape)
 │
W3 — runner-core STX027/STX028               (independent of W1/W2)
 │
 ▼
W4 — extension run-controller plumbing      (needs W3 codes; coded
 │    (probe/spawn injection, pre-run       against W1's /health shape
 │     flow, keep-alive)                    per the spec)
 ├────────────► W5 — inspector attach (§7)  (needs W4's stored health)
 │
 └────────────► W6 — status bar, commands,
                     settings, contributes  (needs W4's spawn/probe helpers)
                      │
                      ▼
                W7 — extension integration tests (after W4–W6)
                      │
                      ▼
                W8 — bump, package, install, live smoke (last)
```

W1 and W3 can start in parallel. W2 alongside W4. Suggested PR split
matching the repo's `PR-N:` convention: **PR-1** = W1+W2 (server + CLI,
ships via server restart), **PR-2** = W3–W8 (runner-core + extension,
ships via VSIX bump).

## Workstreams

### W1 — server core

Files: `src/server/session-manager.ts`, `src/server/api-server.ts`,
`src/server/idle-monitor.ts` (new), `src/cli/commands/serve.ts`,
`src/config/types.ts`, `tests/api-server.test.ts` (extend),
`tests/idle-monitor.test.ts` (new).

**As built**, W1 also added `src/server/health.ts` (the `/health` contract —
`HEALTH_SERVICE_ID`, the response type, and a dependency-free `probeHealth`
the CLI can use without dragging in express/playwright) and
`src/utils/version.ts` (one `getPackageVersion()` for both `steptix --version`
and `/health.version`, which previously read `package.json` twice with
different fallbacks). `startIdleReaper` lives in `idle-monitor.ts` rather
than inline in `startServer`, so the idle conjunction that ships is the one
under test. `createApiServer` returns a fourth member, `beginShutdown()`:
`server.close()` alone is not a work gate, since a client holding a
keep-alive socket can still send a request while sessions are closing.

- `SessionManager.runsInFlight()`: maintained counter, increment on
  entry / decrement in a `finally` around the step-execution body in
  `executeSteps` (§3). Do NOT derive it from per-session state scans.
- `IdleMonitor` (new, tiny): `{ bump(), idleFor(nowMs), armed }` — owns
  `lastActivity`; constructor takes a clock fn for fake-time tests.
- `createApiServer(config, hooks?)` per §2: `/health` registered before
  the auth middleware (§1 shape; `inspector` via
  `require('node:inspector').url() ?? null`; version read from
  package.json at startup — createRequire or fs-read relative to the
  module, never hardcoded); auth middleware calls `idleMonitor.bump()`;
  `/admin/shutdown` validates the 409 (runsInFlight only) then calls
  `hooks.requestShutdown(force)`.
- `startServer`: supplies the real `requestShutdown` (closeAll →
  server.close → exit(0) after ~250 ms grace, 10 s hard-exit fallback);
  30 s idle interval checking `runsInFlight() === 0 && idleFor > N`.
- `serve --idle-timeout <minutes>` flag; `idleTimeoutMinutes?: number`
  optional on `ServerConfig` (no defaults.ts entry; `npm run build`
  regenerates the JSON schema via build:schema).
- Tests per the spec's vitest section — through the real app,
  supertest-style, spy for the hook, fake clock for the monitor.

### W2 — CLI `status` / `stop`

Files: `src/cli/commands/status.ts` (new), `src/cli/commands/stop.ts`
(new), `src/cli/index.ts` (register), tests.

Follow `registerServeCommand` as the pattern. Exit codes and messages
exactly per §4 (0/1/2 for status; 401 message naming both key sources
for stop; post-200 confirm poll). Plain `fetch` with
`AbortSignal.timeout`.

**As built**: target resolution lives in `src/cli/server-target.ts` (not in
`status.ts`) so `stop` doesn't import from a sibling command, and
`src/cli/parse-args.ts` holds the `--idle-timeout` arg parser
(`Number(...)`, not `parseInt` — `parseInt` accepts a numeric prefix, so
`0.5` became `0` and silently disarmed the timeout). `stop` probes
`/health` and checks `service` BEFORE sending the key: §1's "clients MUST
check it" applies to it too, and a foreign process on the configured port
should not be handed `STEPTIX_SERVER_API_KEY`. Both commands export a
`Promise<number>` exit code rather than calling `process.exit`, so the
contract is testable against a stub server.

### W3 — runner-core error codes

Files: `runner-core/src/errors.ts`, `runner-core/tests/errors.test.js`.

STX027 (foreign service on SERVER_URL) + STX028 (auto-start failed), sample
contexts carrying `serverUrl` verbatim — mirror the existing STX010–STX014
entries and the SERVER_URL-audit test pattern. **Run `node --test` in
runner-core** — root vitest does not cover it.

### W4 — extension run-controller plumbing

Files: `steptix-vscode/src/extension/run-controller.ts`, plus a new
`steptix-vscode/src/extension/server-manager.ts` for the
spawn/log/poll logic so run-controller stays lean.

- Constructor-inject `healthProbe?` and `spawnServer?` next to
  `clientFactory` (§5 seam); defaults = real fetch / real
  `child_process.spawn` with the §5.6 options.

**As built**, those arrive in a single trailing `server` deps object
(`{ healthProbe, spawnServer, logPath, keepAliveIntervalMs, pollSleep,
autoStartGuard }`) rather than as more positional parameters — the list had
already reached the point where both call sites passed `undefined`
placeholders. `server-manager.ts` holds the vscode-free pieces
(`defaultHealthProbe`, `defaultServerSpawner`, `startServerAndWait`,
`decideServerAction`, `readAutoStartSettings`, `describeHealth`,
`isLoopbackUrl`, `readLogTail`, `AutoStartGuard`) so the `node --test`
suite can reach them; `run-controller.ts` only maps their results onto the
run's vocabulary.

Two additions the plan didn't anticipate:

- **`decideServerAction`** — the §5.2–5.6 triage is shared by the run path
  and the manual Start Server command. They were written separately first
  and disagreed immediately: the command path lost the "only auto-start a
  localhost URL" rule and would spawn a local server for a remote
  `SERVER_URL`.
- **`AutoStartGuard`** — a failed start suppresses retries for that URL for
  60s. Every batch test re-runs the pre-run phase, so a broken command
  otherwise means one detached shell and one full `readyTimeoutSeconds`
  stall *per test*. Only the timeout arm arms it (the refusals never
  spawned); a success, a manual start, or an edit to `serverAutoStart.*`
  clears it.

The keep-alive covers three client-side pauses, not just the breakpoint one
§3 names: a breakpoint pause (including one on the very first step, where
the run's client doesn't exist yet and the pinned session belongs to the
previous run), an `[input:]` prompt, and an `[interactive]` step. All three
leave the server with no run in flight and no traffic while a human thinks,
which is the blind spot §3 describes.
- Pre-run flow exactly per the §5.1–5.7 decision tree, including: move
  the `AbortController` creation ahead of the health/spawn phase; abort
  ⇒ `aborted`, not STX028; the STX010 message gains the settings hint;
  refuse spawn when `cwd` is blank (STX028 diagnostic); store
  `health.inspector` run-scoped alongside `currentServerUrl`.
- Breakpoint-pause keep-alive per §3: 5-min `GET /sessions/:id` via the
  existing client while paused; cleared on resume/stop/dispose.
- Log file: `<globalStorage>/server.log`, truncated at open when > 5 MB.

### W5 — inspector attach

File: `steptix-vscode/src/extension/extension.ts`
(`handleToolAwaitingDebugger`).

§7 order: health-reported ws URL (normalize `0.0.0.0`/`::` →
`127.0.0.1`) → `null` ⇒ ack-and-continue with the accurate message → no
health data ⇒ settings fallback. Tighten `alreadyAttached` with a port
comparison.

**As built**: the decision is a pure `resolveInspectorTarget` /
`parseInspectorUrl` / `shouldReuseDebugSession` in
`src/extension/inspector-target.ts`, unit-tested under `node --test` —
`vscode.debug.startDebugging` can't run in the electron harness (a real
attach to a port with no inspector hangs ~10s), and the decision is the
part with the bug history. `parseInspectorUrl` additionally requires
`ws:`/`wss:` and a **loopback** host: the value comes from an
unauthenticated response whose `service` field is self-declared, so
without that a responder could name a remote host and have VS Code's debug
adapter dial out to it. A rejected URL falls back to the settings rather
than disabling step-into. `alreadyAttached` compares address as well as
port.

### W6 — status bar, commands, settings

Files: `steptix-vscode/src/extension/extension.ts`,
`steptix-vscode/src/extension/server-status-bar.ts` (new),
`steptix-vscode/package.json` (contributes).

**As built**, the commands live in
`steptix-vscode/src/extension/server-commands.ts` (new) rather than in
`commands/index.ts`, and `resolveServerTarget` is a free function in
`server-status-bar.ts` so the command layer doesn't need a UI widget to
find `SERVER_URL`. `readyTimeoutSeconds` is machine-scoped too — a
workspace-settable value lets a cloned repo stretch a failed start into a
very long wait. The 30s poll stands down while the window is unfocused
(with an `onDidChangeWindowState` catch-up); explicit refreshes — run
start/end, the commands — always go through, since during a UI run the
driven browser usually holds focus.

- Settings per the §5 table — `serverAutoStart.command` / `.cwd` with
  `"scope": "machine"` (the existing settings declare no scope; this
  deviation is deliberate, see §5).
- Commands: Start Server / Stop Server (409 ⇒ Force-stop toast with the
  §6 dropped-stream warning) / Server Status / Show Server Log.
- Status bar per §6, including the legacy-aware ⚠ hover text and the
  workspace-root `.env` + `.env.<activeEnv>` composition for URL/key.

### W7 — extension integration tests

Files: `steptix-vscode/tests/integration/…` (extend), fixtures.

Cases exactly as listed in the spec's integration section, using the
injected probe/spawn — do not stand up a real HTTP server unless a case
genuinely needs one. Follow the existing harness structure
(FakeApiClient, runtime-generated gitignored `.env.*` fixtures,
STEPTIX_GREP).

### W8 — ship

**Status: 0.5.67 → 0.5.68 built, packaged and installed.** The live smoke
(step 4) is the remaining item and needs a human at the editor.

1. Bump `steptix-vscode/package.json` patch version (the runner-core
   change rides this bump; Monaco deliberately untouched, §8).
2. `npm run build && npm run package` in steptix-vscode; install the
   VSIX via the code.cmd CLI shim at its full path (plain `code`
   resolves to the GUI exe); reload the window; confirm the new version
   in the Extensions panel.
3. Root repo: `npm run build` (the server runs dist/ — a server-side
   change is not live until rebuilt) and restart the server.
4. Live smoke per the spec's Live section.

## Code review

1. After each workstream, verify with `git diff` — the diff is ground
   truth, not agent narration.
2. Run the `simplify` skill on each PR's changed files before review.
3. Spawn a reviewer agent for W1 and W4 (most surface, most error-prone).
   W1 focus: idle semantics vs §3, 409 semantics vs §2, counter
   placement / decrement-on-throw. W4 focus: decision-tree branch
   coverage vs §5, abort behaviour, keep-alive lifecycle leaks.
4. `security-review` skill before merging PR-2 — focus: the spawn
   (machine-scoped settings actually declared; cwd-refusal implemented;
   command never sourced from workspace config), and that `/health`
   leaks nothing sensitive.

## Repo gotchas (from project memory — real, previously hit)

- Root `npm test` occasionally fails ALL files at once (transient
  worker-pool crash, ~8 s, 0 tests). Re-run before believing it's a
  regression.
- steptix-vscode builds with esbuild — it does NOT typecheck. Run the
  typecheck script (or `tsc --noEmit`) explicitly.
- Test at the client seam: server endpoints get
  supertest-through-real-app tests, not resolver units.
- Live suite: server via
  `node --env-file=templates/.env --import tsx src/index.ts serve`, then
  `STEPTIX_LIVE_GREP=… npm run test:live` in steptix-vscode.
  `store-as-survives-breakpoint` and `pause-resume` are known-flaky —
  re-run in isolation before calling a regression.
- VS Code commands/message types are often registered in two places —
  grep all handlers before declaring a change done.
