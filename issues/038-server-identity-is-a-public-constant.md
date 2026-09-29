# 038 — Server identity is a public constant, so the "is this ours?" check stops accidents, not attackers

**Status:** open / security — accepted for a localhost dev tool; revisit before
this runs anywhere less trusted.
**Area:**
[src/server/health.ts:16](../src/server/health.ts#L16) (`HEALTH_SERVICE_ID`, the whole identity);
[src/server/health.ts:108-112](../src/server/health.ts#L108-L112) (`isHealthResponse` — the entire test is `service === HEALTH_SERVICE_ID && ok === true`);
[src/mcp/server-start.ts:247](../src/mcp/server-start.ts#L247) (arm 2 — refuses an unrecognised responder);
[src/mcp/server-start.ts:206](../src/mcp/server-start.ts#L206) (`assertServerRecognized` — the same check for the tools that send the key without running anything);
[src/cli/commands/stop.ts](../src/cli/commands/stop.ts) (`steptix stop` probes `service` before sending the key — same weakness).
**Related:** [stories/mcp-server.md §5](../stories/mcp-server.md) (the arm-2
refusal and its rationale), [039](039-toctou-between-confinement-check-and-read.md)
(the other accepted MCP security gap).
**Opened:** 2026-07-24

## Summary

Every client decides "is the thing on this port our server?" by fetching
`/health` and comparing one field to a hard-coded string that is checked into
this repo. That correctly stops the *accident* — some other dev server on
3100, or a stale process — which is what it was written for. It does not stop
a **deliberate** local squatter: any process that binds the port first and
answers

```json
{"ok": true, "service": "steptix", "version": "1.0.0", "pid": 1,
 "startedAt": "…", "openSessions": 0, "runsInFlight": 0,
 "inspector": null, "idleTimeoutMinutes": null}
```

is treated as ours, and the next request hands it `STEPTIX_SERVER_API_KEY` **and the
project's entire composed `.env`** as the request's `env` field. For this repo
that means the AI gateway key plus the banking and GitHub credentials in
`.env`.

## Context

The check exists because of a real failure it does prevent: spawning a second
server on top of a port something else already holds, and then reporting
"your server never became healthy" about a process that was never ours. The
MCP server tightened it further than Steptix does — Steptix proceeds on an
unrecognised answer (assuming an older Steptix build), while the MCP server
refuses, precisely because it sends far more than Steptix does.

But the tightening is about *which answers are accepted*, not about *how hard
the answer is to forge*. The bar to forge it is: bind 127.0.0.1:3100 before
steptix does, and serve eight fields of static JSON.

Threat model, honestly stated:

- **Not in scope from the network.** The server binds loopback, and `/health`
  is registered before the wildcard-CORS middleware specifically so a web page
  cannot read it ([api-server.ts:76](../src/server/api-server.ts#L76) and the
  comment above it).
- **In scope from any local process.** Anything running as the developer can
  claim the port. On a shared build agent or a machine with untrusted local
  software, that is a credential handoff with no user-visible symptom — the
  agent's run simply fails afterwards, which reads as a flaky test.
- The MCP server widens the blast radius over Steptix in two ways: it is
  spawned automatically by an agent host (no human watching the first
  connection), and one server serves *every* project pointing at that
  `SERVER_URL`, so one squatter collects each project's `.env` in turn.

## Decision (for now)

Accept. This is a localhost developer tool, the port is loopback-only, and an
attacker who can already run code as the developer has cheaper routes to the
same `.env` file. Fixing it properly costs a real mechanism (below) that would
have to work for the CLI, both Steptix variants and the MCP server at once.

## Options when picked up

1. **Per-machine shared secret in the health response.** The server writes a
   random token to a file only the developer can read (e.g.
   `~/.steptix/instance-token`, or beside the project's `.env`); `/health`
   returns a value derived from it, and clients compare. Cheap, and it makes
   forgery require reading a file the attacker may not have. Weakness: any
   local process running as the developer *can* read that file, so it raises
   the bar without closing the hole.
2. **Bind-before-probe.** Rather than asking who is there, try to bind the
   port ourselves. If the bind succeeds nothing was listening (so the
   subsequent spawn is safe); if it fails with EADDRINUSE, *then* probe. This
   removes the "spawn on top of a foreign process" failure the check was
   written for, but does not by itself authenticate an existing server.
3. **Prove possession of the key without disclosing it.** Have `/health`
   accept a nonce and return an HMAC over it under `STEPTIX_SERVER_API_KEY`. A
   squatter without the key cannot answer, and we never send the key to an
   unproven server. This is the actual fix; it needs a server change and a
   version-negotiation story for older servers.
4. **Do not send the composed `.env` at all** unless the server has been
   proven ours — degrade to `envName`-only resolution, so a squatter that
   fools us still gets no secrets. Narrows the damage rather than closing the
   hole, and is cheap.

Option 3 is the correct one; option 4 is a worthwhile independent mitigation
and could land first.

## Revisit conditions

Pick up when any of: (a) the framework is used on a shared or multi-user
machine (CI runner, build agent, shared dev box); (b) `SERVER_URL` is ever
pointed at a non-loopback address; (c) the MCP server is exposed over a
transport other than stdio (the deferred Streamable HTTP option in
[stories/mcp-server.md](../stories/mcp-server.md) "Out of scope"); or (d) any
client starts sending something more sensitive than it does today.

## Why this matters

The code reads as though it authenticates the server — the arm-2 refusal is
commented at length about not handing credentials to strangers, and it is the
control the MCP spec leans on. It is worth being precise in the tracker that
what it actually provides is collision detection. Someone hardening this later
should not have to rediscover that the check is a string compare against a
constant in the repo.
