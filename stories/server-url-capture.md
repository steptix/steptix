# The server writes its own address — projects stop configuring SERVER_URL

## In plain terms

[machine-key.md](machine-key.md) removed the key from every project. This
story removes the *address*. When the Sessions API server starts, it writes
the URL it actually bound to a well-known file in the user root; every client
reads that file as its last resort. A project that says nothing about
`SERVER_URL` just finds the machine's server — and if the server came up on a
different port, the file says so, because the server wrote it after binding.

TestBench then needs exactly one piece of machine setup: **where the
framework is** (`serverAutoStart.cwd`, e.g. `C:\Projects\vibe\ai-ui-automation`).
The auto-start command stops being something you write — it ships with the
default

```
node --inspect=0 dist/index.js serve --idle-timeout 60
```

and the server key, the server URL, and the AI defaults all resolve from the
machine without a line of per-project configuration. You type `AI_API_KEY`
and `AI_MODEL` into the user root's `.env` once — a settings UI for that can
come later — and projects that want their own keep their own, exactly as the
machine-key ladder already provides.

Builds **after** [machine-key.md](machine-key.md), on top of its user root.

> **Verification rule for this story.** "Done" means: (1) a bare `aiui serve`
> writes the bound URL to the user-root pointer file after listen succeeds —
> never before — and restarting on a different `--port` updates it; (2) a
> TestBench run against a project whose `.env` has **no** `SERVER_URL`
> resolves the machine server and passes, in both variants; (3) every MCP
> tool works against such a project; (4) `aiui stop` with no `--url` and no
> config stops the machine server via the pointer; (5) a project `.env` that
> sets `SERVER_URL` still wins, so a project-pinned server is untouched; (6)
> a stale pointer — server killed, file left behind — fails the probe and
> auto-start self-heals it: the spawned server rewrites the pointer; (7) URL
> capture never rewrites the user root's `.env` — the pointer is its own
> file, and a hand-edit to `.env` mid-run survives any number of server
> starts; (8) the auto-start *command* ships with the default above while
> `cwd` stays empty and user-set, and auto-start still refuses without a
> `cwd` (TB028) — a workspace can set neither, so a cloned repo still cannot
> run code by being opened.

## Context

Who resolves `SERVER_URL` today, and where each path dead-ends:

| Reader | Resolution today | Consequence |
| --- | --- | --- |
| TestBench (both variants) | walk-up `.env` only | refuses the run without it ([run-controller.ts:1412](../testbench-native/src/extension/run-controller.ts:1412)) |
| MCP server | project `.env` → `process.env` | [project.ts:360](../src/mcp/project.ts:360) — no project value means no address at all |
| `aiui stop` / `status` | `--url` flag → config `server.host/port` | a server on a non-default port is invisible without the flag |
| Sessions API server | binds config/flags, tells nobody | the port it actually bound exists only in its log |

The server is the one process that *knows* its address with certainty, and it
is the only one that never says. Everyone else guesses from configuration —
which is why the configuration has to exist in every project today.

The repo already owns the correct pattern: a Chromium profile's
`DevToolsActivePort`, a runtime pointer written by the process that bound the
port, read back by anyone who needs it, stale-checked by probing
([cdp-registry.ts:240](../src/browser/cdp-registry.ts:240)). This story is
that pattern applied to our own server.

## What we suggest

**A pointer file, not a `.env` line.** The server writes
`<user-root>/server.json` — `{ "url": "...", "pid": ..., "startedAt": "..." }`
— after `listen()` succeeds, never before, so the file can never name a port
that failed to bind. It rewrites the file on every start; that is its job.

It is deliberately **not** written into the user root's `.env`. That file is
hand-edited (`AI_API_KEY` and `AI_MODEL` are typed into it) and
[machine-key.md](machine-key.md) keeps machine writes to it append-once — a
value rewritten on every server start would have the server racing the
user's editor for the same file, and the lost edit would be the user's
credentials. Runtime state and human configuration get different files; the
`DevToolsActivePort` precedent is exactly this split.

**One resolution order, explicit beating captured:**

```
clients:  project .env SERVER_URL → process.env → user-root server.json
serve:    --host/--port/config, exactly as today → then writes the pointer
```

Clients means all of them: TestBench (both variants), the MCP server, and
`aiui stop`/`status` — which closes the last "started it, can't find it"
gap. A stale pointer is handled the way a stale `DevToolsActivePort` is:
probe it, and a dead or foreign answer means "not running", never an error
surfaced to the user. `pid` and `startedAt` are there so `aiui status` can
say *why* a pointer was disregarded.

**TestBench ships a default auto-start command.** With the URL and key both
machine-resolved, the command has no per-machine content left — so it stops
being configuration the user writes and becomes a default they can override.
`serverAutoStart.cwd` stays empty by default, stays machine-scoped, and
auto-start still refuses without it: the framework's location is the one
genuinely per-machine fact, and it is also the security gate. The command
executes relative to a directory only the user can set, so a cloned repo
gains nothing from the command having a default.

**After a spawn, the address comes from the pointer.** Today TestBench polls
`/health` on a URL it already knew. Under this story the spawned server may
be the first thing that *establishes* the URL, so the auto-start wait
becomes: poll for the pointer file, then poll its `/health` until it
identifies as ours — the same two-step CDP launch uses
(`DevToolsActivePort`, then the probe).

## Not in this story

- **A UI for the machine values.** `AI_API_KEY` / `AI_MODEL` stay typed into
  the user root's `.env` by hand for now; a settings surface comes later.
- **Multiple concurrent machine servers.** The pointer names one server —
  last started wins, which is the machine-key philosophy applied to the
  address. A project that wants its own server pins `SERVER_URL` in its
  `.env` and never touches the pointer.
- **OS-assigned ports (`--port 0`).** The pointer would make it possible —
  bind on 0, capture what the OS chose, exactly like CDP launch. Worth doing
  only if 3100 collisions actually hurt; noted so it's a decision, not an
  accident.

## Notes for implementation

- Write the pointer atomically (write temp + rename) — a client reading
  mid-write must see the old pointer or the new one, never half a JSON.
- TestBench changes land in both variants; patch bump and repackage each.
- `aiui status` should report the pointer and its verdict ("stale — pid 1234
  gone") rather than silently ignoring it; that is the file's debuggability
  story.
- The MCP server's auto-start already knows the URL it spawns with; the
  pointer matters to it only for *finding* a server nobody configured. The
  project-less default port question stays with
  [mcp-no-project.md](mcp-no-project.md).
