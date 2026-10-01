# One machine key — generated, never typed

## In plain terms

`STEPTIX_SERVER_API_KEY` is a shared secret between local processes: Steptix
and the MCP server prove to the Sessions API server that they're allowed to
drive it. It is not user authentication — there is one user, and everything
runs as them on one machine.

Today that secret behaves like per-project configuration. Every project's
`.env` carries a copy, `templates/.env` and `.env.example` tell new projects
to add one, worktree seeding copies it around, and a server started by hand
needs `--env-file` to find it. Get any copy out of sync and you have a 401
that looks exactly like a foreign process squatting the port.

This story makes it what it actually is: **one key per machine, created by
the framework itself, living outside every repo.** Nobody types it, no
project carries it, and every client finds it in the same well-known place.

Before: clone a project → copy `.env.example` → paste a key that must match
whatever the server was started with → 401 when it doesn't.

After: `steptix serve` on a fresh machine just works — the key is generated on
first start. Steptix just works — it reads the same file. A project `.env`
never mentions the key at all.

The same file also carries machine defaults for `AI_API_KEY` and `AI_MODEL`
— typed once (these are real credentials; nothing can generate them), used
whenever a project doesn't set its own.

This story stands alone and **ships before**
[mcp-no-project.md](mcp-no-project.md), which widens the same directory into
a full user root. Nothing here depends on that story; it depends on this one.

> **Verification rule for this story.** "Done" means: (1) on a machine with
> no key anywhere — no env var, no user-root `.env`, none in the project —
> `steptix serve` starts, generates a crypto-random key, and writes it to the
> user root's `.env`; a second `serve` reuses that key rather than
> regenerating; (2) a Steptix run against that server passes with **no**
> `STEPTIX_SERVER_API_KEY` in the project's own `.env` — proven in both
> variants; (3) `steptix stop`, run from a shell with no key in its
> environment, stops that server; (4) every MCP tool works against a project
> whose own `.env` carries no key; (5) a project `.env` that deliberately
> sets its own key still wins — the client sends the project's key, not the
> machine's; (6) an explicit key in `process.env` (including via
> `--env-file`) beats the user-root file for `serve`; (7) `templates/.env`
> and `.env.example` no longer list the key, a fresh worktree needs no key
> seeded into it, and the `serverAutoStart.command` suggested value teaches
> the bare command with no `--env-file`; (8) a run against a server started
> bare — no `--env-file`, nothing in the shell — uses the user root's
> `AI_API_KEY` and `AI_MODEL` when the project sets neither; (9) a project's
> own `AI_MODEL` beats the user root's whether it is set in the project
> `.env` **or** in the project's `steptix.config.json` — the machine value is a
> floor, never an override; (10) on a machine with no key anywhere and no
> server running, a Steptix Run with auto-start configured starts the server
> and passes, sending the key that server generated. With a server already
> running and no key anywhere, the same Run refuses with STX003 and spawns
> nothing.

## Context

The same secret is resolved five different ways:

| Reader | Resolution today | Consequence |
| --- | --- | --- |
| `steptix serve` | `process.env` only — hard exit without it | [serve.ts:36](../src/cli/commands/serve.ts:36); the message says "add it to your .env file", which `serve` never reads |
| `steptix stop` | `process.env` only | [stop.ts:42](../src/cli/commands/stop.ts:42) — can't stop a server whose key came from a project `.env` it can't see |
| MCP server | project `.env` → `process.env` | [project.ts:367](../src/mcp/project.ts:367) |
| Steptix (native) | walk-up `.env` only — refuses without it | [run-controller.ts:1423](../steptix-vscode/src/extension/run-controller.ts:1423) |
| Steptix (monaco) | walk-up `.env` only — refuses without it | [run-controller.ts:293](../testbench-monaco/src/extension/run-controller.ts:293) |

Because client and server resolve in *different orders* — a project `.env`
beats the environment on the client side, while the server sees only its
environment — a project with its own key silently disagrees with a server
started from `templates/.env`, and the failure is a bare 401
indistinguishable from a squatter on the port.

Two facts shape the fix:

- **Nothing issues the key.** Auto-start hands `project.apiKey` to the child
  it spawns through the environment ([server-start.ts:582](../src/mcp/server-start.ts:582)).
  The two sides agree because one gave the string to the other — so a
  generated random string is exactly as good as a typed one.
- **"The framework's `.env`" is not one file.** Worktrees under
  `.claude/worktrees/` each hold a copy seeded by `init-worktree.ps1`, and an
  npm-installed framework would have no checkout at all. Only one path is
  per-machine unique: `%LOCALAPPDATA%\steptix\` on Windows,
  `$XDG_CONFIG_HOME/steptix/` or `~/.steptix/` elsewhere.

## What we suggest

**The key's canonical home is `%LOCALAPPDATA%\steptix\.env`.** This story
creates only that file, on demand. ([mcp-no-project.md](mcp-no-project.md)
later grows the same directory into a full user root — config, browser
profiles — and everything here is designed so that lands on top without
change.) Steptix needs no new setting to find it: a well-known path
replaces a configured one. `serverAutoStart.cwd` stays, but only for
*launching* the framework — the key no longer depends on knowing where the
checkout is.

**Whichever process needs a key first and finds none generates it** —
crypto-random, written to the user-root `.env`, only ever when the file is
absent (by the second write it may carry values the user added by hand):

- `steptix serve` on a bare start: generate, write, continue. This replaces
  today's hard exit and its misleading message. Generation at *install* was
  considered and rejected — there is no reliable install hook (`postinstall`
  is routinely disabled, a `git pull` upgrade never runs one), while
  first-use covers install, upgrade and fresh machines with one mechanism.
- The MCP server, before an auto-start spawn (§5 arm 4, down + loopback):
  same. **And only then** — against a server already up and identifying as
  ours, a generated key would just be rejected (that server has whatever key
  *it* was given), so the honest answer there stays a refusal naming the
  file to write. Bare `serve` binds the port itself, so the conflict cannot
  arise on its path.

Steptix is on neither list and never generates: a key it invented would be
one no running server holds. But its auto-start (server-lifecycle §5.6)
spawns exactly the bare `serve` above, so on a machine with no key yet,
**Steptix reads the key after the server check, not before.** Server down,
on this machine and auto-start configured: spawn, wait for `/health`, then
read the chain below; the spawned `serve` has written the machine key by
then. Server already up, or not ours to start, and still no key: refuse
with STX003, naming the file, which is the same answer the MCP server gives
for the same case.

*Amended 2026-10-01.* As first built, Steptix required the key before the
server check. A fresh machine whose only client was Steptix therefore
refused every run with STX003, and the auto-start that would have created
the key never ran. Verification rule (2) did not catch it, because it ran
Steptix against a server `serve` had already started. Rule (10) covers
the case.

**One resolution order, explicit beating generated:**

```
serve:    process.env (incl. --env-file)  →  user-root .env  →  generate
clients:  project .env (walk-up)  →  process.env  →  user-root .env
```

Clients means all of them: Steptix (both variants), the MCP server, and
`steptix stop` — which is what finally lets `stop` stop everything `serve` can
start.

*Amended 2026-10-01.* Steptix resolves `SERVER_URL` by the same client chain,
with one rung more: project `.env` → the environment → `SERVER_URL` in the
user root's `.env` → `http://127.0.0.1:3100`, where `serve` listens by
default. With both values at machine level, a project needs no `.env` at all.
The MCP server's project scope still requires a project to name its server.

**Projects stop *needing* the key, not stop being *allowed* one.** The
project-`.env`-first order above is unchanged, so a project that sets its
own key still wins — that is deliberate, and it is why rule (5) exists. The
default is simply that no project sets one, which is what makes "one key in
existence" the normal state and the 401-mismatch impossible by construction.

**The same file carries machine defaults for `AI_API_KEY` and `AI_MODEL`.**
Typed once by hand — these are real credentials, so unlike the server key
nothing can generate them. The default flows through the *server*, not the
clients: no client reads the user root's AI values, the Sessions API server
takes them as its own bottom layer, and a project that sets either value in
its `.env` already sends it per-request and already wins. Project-over-
machine precedence therefore costs no Steptix or MCP change at all — and
projects that stop carrying AI keys they never needed also stop shipping
them in request payloads past the issue-038 boundary.

The precedence ladder is locked, and it is **not** today's loader order:

```
project .env  →  project steptix.config.json  →  user-root .env  →  built-in
```

`loadConfig` is currently inconsistent — env `AI_API_KEY` only fills in when
the config file has none ([loader.ts:70](../src/config/loader.ts:70)), but
env `AI_MODEL` *overrides* the config file
([loader.ts:75](../src/config/loader.ts:75)). Naively preloading the
user-root `.env` into `process.env` would therefore let a machine-wide
`AI_MODEL` silently override every project's `steptix.config.json` model. A
default that beats explicit project config is not a default — so user-root
values enter the loader as a distinct bottom layer, consulted only when
nothing above set the value, per verification rule (9).

**The suggested auto-start command loses its `--env-file`.** The
`serverAutoStart.command` setting currently teaches
`node --inspect=0 --env-file=templates/.env dist/index.js serve
--idle-timeout 60` and warns that the server's key "must match the one in
the project's `.env` that Steptix sends, or runs will fail with a 401".
The new suggestion is:

```
node --inspect=0 dist/index.js serve --idle-timeout 60
```

`serve`'s own chain finds the user-root `.env`, so the flag is unnecessary —
and the 401 warning paragraph is deleted, because the mismatch it warns
about can no longer exist. Ship the description change **with** the `serve`
chain change, never before it: against today's `serve`, the bare command
hard-exits on every machine.

## Not in this story

- **Issue 038** (server identity is a public constant) is unchanged: a local
  squatter answering `/health` correctly is still handed the key. Same
  boundary as today, same accepted risk.
- **Multiple servers with deliberately different keys** keep working via
  per-project keys; nothing new is built for them.
- **Everything [mcp-no-project.md](mcp-no-project.md) covers** — machine-wide
  browsers, project-less tool calls, the user root as a full project root.

## Notes for implementation

- Steptix changes land in both variants' `run-controller.ts`; per project
  rules that means a patch bump and repackage of each.
- `stop`'s error message and `serve`'s old one both name files they don't
  read; both get replaced by the chain above and messages that name the file
  actually consulted.
