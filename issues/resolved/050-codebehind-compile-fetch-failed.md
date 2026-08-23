# 050 — Code-behind Compile failed with a bare "compile failed: fetch failed"

**Status:** ✅ **RESOLVED — implemented + tested (2026-08-23).**
**Area:** [testbench-native/src/extension/run-controller.ts](../../testbench-native/src/extension/run-controller.ts) (`compileCodeBehind`, `resolveClient`, `ensureServerReady`), [runner-core/src/api-client.ts](../../runner-core/src/api-client.ts) (`describeFetchError`), [testbench-native/src/extension/server-manager.ts](../../testbench-native/src/extension/server-manager.ts) (`defaultHealthProbe`, `withTimeout`)
**Related:** [stories/server-lifecycle.md](../../stories/server-lifecycle.md) §5 — the pre-run probe + auto-start that Compile now shares; [stories/codebehind-compile.md](../../stories/codebehind-compile.md) §What the author sees
**Opened:** 2026-08-23
**Resolved:** 2026-08-23

## Summary

Running Compile Code-behind on a second machine put this in the TestBench
output and nothing else:

```
[21:14:02] compile requested for C:\AITests\tests\login.md
[21:14:02] compile failed: fetch failed
```

Which server? Why did it not answer? The line could not say. Two gaps, one
in each half of the path:

1. **Compile skipped the server check a Run does.** `runLines` calls
   `ensureServerReady` — `GET /health`, then spawn via
   `testbench-native.serverAutoStart` if the URL is down and that is
   configured, or refuse with TB027 if the port belongs to something else.
   `compileCodeBehind` went `resolveClient()` → `POST /codebehind/compile`
   with no probe in between. On a machine where the Sessions API server only
   ever comes up because someone pressed Run, the first Compile of a window
   (or any Compile after the server stopped) hit a dead port.

2. **The transport reason was thrown away.** Node's `fetch` reports every
   transport failure as `TypeError: fetch failed` and parks the actual error
   on `cause` — `connect ECONNREFUSED 127.0.0.1:3100`, `getaddrinfo ENOTFOUND
   build-box`, a certificate error. `ApiClient` wrapped `err.message` only,
   at six sites, so `connect-failed` errors all read "fetch failed". The
   `/health` probe did the same, so even the Run path's "server down" line
   carried no reason.

## Fix

**`describeFetchError(err)`** in runner-core walks the `cause` chain and joins
the links with `: `. The awkward case is the common one: for a `localhost`
URL Node tries `::1` and `127.0.0.1` in turn and wraps both refusals in an
`AggregateError` whose own message is *empty*, so the helper descends into
`errors[]` or the line would end in a bare `fetch failed: `. Every
`connect-failed` and `stream-dropped` wrap in `ApiClient` uses it, as does the
health probe's `down` detail. The probe's timeout now aborts with a reason
(`no answer within 1000 ms`) instead of the generic "This operation was
aborted" a user Stop also produces.

**Compile now runs `ensureServerReady`** before its POST — the same decision
tree as a Run: healthy ⇒ proceed; foreign ⇒ TB027 without sending anything;
down + localhost + configured ⇒ spawn and wait; down otherwise ⇒ log the
probe's reason and let the request's own failure be reported. The log names
the target first (`server <url> (SERVER_URL in <path>)`, or `(the last run
in this window)`), so the URL is on record even if the probe hangs.
Transport and HTTP failures are mapped through the same `mapApiErrorToPayload`
a Run uses, so the notification and the log carry the catalogue's diagnosis
*and* fix (TB010 with the settings hint, TB011 for a rejected key) instead of
the client's raw reason. TB010's fix text used to say "run 'npx tsx
src/index.ts serve' in the ai-ui-automation repo" — a machine that only has
the package installed has no repo to run that in, so it now names the
package's own CLI: `npx aiui serve` in the test project, or `aiui serve` when
installed globally. The `serverAutoStart.command` / `.cwd` setting
descriptions had the same assumption ("normally your ai-ui-automation
checkout"); they now give both forms — `npx aiui serve --idle-timeout 60`
with `cwd` = the test project, and the checkout's `node --inspect=0
dist/index.js serve …` — and say how to keep the inspector with the package
(`node --inspect=0 node_modules/ai-ui-automation/dist/index.js serve …`,
verified to report its inspector on `/health`). A 409 (`conflict`, "a
compile of X is already running") keeps the server's wording.

Two things fell out of doing that safely. `resolveClient` now returns the
URL, its provenance and the `.env` it came from alongside the client. And
Compile refuses while a run of the same test is in flight: the panel already
greys the button out, but the palette and gutter commands did not check, and
a compile records in the session the run is using — the new probe would also
have reset the run's inspector URL under it.

`instanceof ApiClientError` does not cross the esbuild bundle boundary (the
reason `isUserAbort` duck-types), so the compile catch and
`mapApiErrorToPayload` now duck-type too; the integration fake's errors
come from the other copy.

## Before / after

Same machine, nothing listening on the port in `.env`:

```
compile failed: fetch failed
```

```
server http://localhost:3105 (SERVER_URL in C:\AITests\.env)
server down at http://localhost:3105 (fetch failed: connect ECONNREFUSED ::1:3105; connect ECONNREFUSED 127.0.0.1:3105) — not auto-starting ("testbench-native.serverAutoStart.command" is not set)
compile failed: TB010: Cannot reach the ai-ui-automation server at http://localhost:3105 (fetch failed: connect ECONNREFUSED ::1:3105; connect ECONNREFUSED 127.0.0.1:3105). Start it with 'npx aiui serve' in your test project (or 'aiui serve' if the package is installed globally), then confirm SERVER_URL names the host and port it is listening on. If it runs on another machine, check the firewall. To have TestBench start it for you, configure "testbench-native.serverAutoStart.command" and ".cwd" in your user settings.
```

A hostname that does not resolve reads `fetch failed: getaddrinfo ENOTFOUND
build-box`; a self-signed certificate `fetch failed:
DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate`.

## Tests

- runner-core `node --test`: `describeFetchError` over the shapes captured
  from Node 22 (refused, dual-stack AggregateError, DNS, TLS, undici timeout
  code, plain error, cyclic cause, mid-stream drop); the existing
  connect-failed tests now assert the cause reaches the message.
- testbench-native unit: the probe's `down` detail names the refused port;
  a never-answering server's detail says it timed out, with and without a
  caller signal.
- testbench-native integration (`codebehind.test.cjs` › *reaching the
  server*): TB010 naming URL + cause + the settings hint; TB011 with the
  `.env`; auto-start spawns before the request; TB027 sends nothing;
  compile during a run is refused without touching the server. A
  `lastCompileError` test hook exposes the notification text, which is not
  readable from the extension host.

## Not done here

`resolveClient` reads base `.env` only when no run has happened in the
window; a selected `.env.<name>` that overrides `SERVER_URL` is applied by
the Run path (`composeEnv`) but not by this fallback, so a Compile before any
Run can target the base server while sending `envName` for the recording.
Pre-existing and accepted in `resolveClient`'s own comment; the new
`server … (SERVER_URL in <path>)` line at least makes it visible.
