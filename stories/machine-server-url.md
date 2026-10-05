# One default server per machine — no `.env` needed to run a test

## In plain terms

A Markdown file with a `## Steps` heading runs in Steptix without any project
around it: no `.env`, no `steptix.config.json`. When nothing names a server,
every client and the server itself agree on the same one — `STEPTIX_SERVER_URL` in the
machine `.env` (`%LOCALAPPDATA%\steptix\.env`, `~/.steptix/.env` elsewhere),
else `http://127.0.0.1:3100`.

Steptix itself got there first ([machine-key.md](machine-key.md), amended
2026-10-01): a run with no project `.env` uses the machine URL, else the
default, and with no command setting it starts the installed runtime on that
port. This story makes the rest agree with it. Before:

- a bare `steptix serve` listened on `server.port` from whatever
  `steptix.config.json` it found, so the server and Steptix could pick
  different ports;
- MCP refused a project whose `.env` had no `STEPTIX_SERVER_URL`, and its
  project-less calls used a different default (3141) from everything else;
- `steptix status` and `stop` looked at `server.port` too.

After: they all land on the machine's server. A project `.env` still decides
where *that project* connects; it just isn't required.

## Where the server listens

`steptix serve` takes its port from, in order:

1. `-p` / `--port` on the command line;
2. the port of `STEPTIX_SERVER_URL` in the machine `.env`;
3. 3100.

A project's own files never decide it. `server.port` in `steptix.config.json`
is dropped with a warning, and a project `.env`'s `STEPTIX_SERVER_URL` only says where
that project connects. A server for a project on another port is started with
`-p`.

Only the port is taken from the machine URL — the bind address stays
`server.host` (or `-H`). A machine `STEPTIX_SERVER_URL` that is not a URL, or names no
port, stops a bare `serve` before it binds, naming the file: falling back to
3100 would start a server no client is looking for.

A taken port exits with the port and where it came from — `Port 3200 (from
STEPTIX_SERVER_URL in C:\…\steptix\.env) is already in use` — instead of a bare
EADDRINUSE stack. Still fatal, which MCP auto-start depends on.

## Where clients connect

| Client | Order |
| --- | --- |
| Steptix (run, Record Steps, Compile, status bar, Start/Stop Server) | project `.env` (+ `.env.<name>`) → the environment → machine `.env` → default |
| MCP server, project or project-less | project `.env` → `process.env` → machine `.env` → default |
| `steptix status` / `steptix stop` | `--url` → machine `.env` → `http://<server.host>:3100` |

`steptix run` executes in-process and talks to no server.

The environment rung is the one place a client and a bare `serve` can
disagree: `serve` does not read `STEPTIX_SERVER_URL` from its environment,
because the project `.env` it loads lands there too and a project must not
decide the port. Set it in the machine `.env` to move the default server.

The run log says which one a run used, e.g. `STEPTIX_SERVER_URL
http://127.0.0.1:3100 — from the default …`, so a run that landed on the
machine server by accident is visible.

## Auto-start never starts a server it will not connect to

The installed runtime is always started with `--port` set to the run's port,
and MCP auto-start passes `--port` itself, so both land on the URL they use.

`steptix.serverAutoStart.command` is a user-written shell string, so it can
land elsewhere. Before spawning it, Steptix works out where it will listen — a
`-p` / `--port` after the word `serve` in the command, else the machine
`STEPTIX_SERVER_URL`'s port, else 3100 — and compares that with the URL it is
about to use. On a mismatch it refuses with **STX033**, naming both ports and
where each came from, and suggests `steptix serve -p <port>`. If the machine
`STEPTIX_SERVER_URL` would stop the server from starting at all, it reports
STX028 with that reason instead of waiting out the timeout. Start Server
refuses the same way.

## Linux and macOS

The machine `.env` is `$XDG_CONFIG_HOME/steptix/.env` when that variable is
set, else `~/.steptix/.env`; the framework and runner-core resolve it by the
same rule.

**It is private, as `%LOCALAPPDATA%` is on Windows.** It holds the server key
and, once this story makes it the place for them, `AI_API_KEY`; the same
folder holds signed-in CDP browser profiles. So:

- Everything that can create the folder — the machine key, the stats store,
  a CDP profile, MCP's server log — creates it `0700`. The key file is created
  `0600`.
- Adding the key to an existing `.env` (one made by hand for `AI_API_KEY`)
  first sets it `0600`.
- Reading a `.env` that other users can read warns once with the exact
  `chmod 600` command: from `serve`, the CLI and MCP through the logger, and
  from Steptix in the run log. A warning, not a refusal — the file works, and
  a run that stopped over its permissions would be worse than one that says
  how to fix them.

Node ignores these bits on Windows, so none of this changes anything there.

**`XDG_CONFIG_HOME` has to look the same to the server and to VS Code.** Set
only in a shell startup file, a `serve` started from that shell reads a
different `.env` from a VS Code that did not inherit it, and the two disagree
on the port and the key. Documented rather than engineered around: auto-start
hands VS Code's environment to the server it starts, macOS VS Code reads the
login shell's environment at startup, and a mismatch already surfaces as a 401
naming the key file Steptix read.

## Decisions

- **No discovery file.** A `server.json` written by each server was considered
  and dropped: one fixed default port means at most one default server, so
  there is nothing to discover, and the machine `.env` is the one place to
  move it.
- **3100, not 3141, for project-less MCP calls.** 3141 kept project-less calls
  off a project server whose key they might not hold; with one machine key per
  machine that reason is gone, and one shared default server is the point.
- **`127.0.0.1`, not `localhost`, in the default URL** — exactly what a default
  `serve` binds, whichever address family `localhost` resolves to first.

## Out of scope

- A file opened with no folder open still refuses with STX030.
