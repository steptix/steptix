# 040 — The auto-start server log holds resolved secrets and is world-readable on Windows

**Status:** open / security — accepted; `0o600` is correct on POSIX and inert
on the platform this project primarily runs on.
**Area:**
[src/mcp/server-start.ts:638](../src/mcp/server-start.ts#L638) (`openSync(logPath, 'a', 0o600)` — the mode that does nothing on win32);
[src/mcp/server-start.ts:612](../src/mcp/server-start.ts#L612) (the comment recording the measurement);
`LOG_RELATIVE_PATH` = `<project_root>/.steptix/mcp-server.log`;
[src/server/session-manager.ts](../src/server/session-manager.ts) (`logger.step(...)` writes the **post-interpolation** step text, which is what lands in the file);
[.gitignore](../.gitignore) (`.steptix/` — the file is at least not committable).
**Related:** [stories/mcp-server.md §5](../stories/mcp-server.md) (log file
rules and the §Risks entry), [038](038-server-identity-is-a-public-constant.md),
[039](039-toctou-between-confinement-check-and-read.md).
**Opened:** 2026-07-24

## Summary

When the MCP server auto-starts a Sessions API server, the child's stdout and
stderr go to `<project_root>/.steptix/mcp-server.log`, opened with mode `0o600`.
That mode is honoured on POSIX and **inert on Windows** — measured on this
machine, the file lands as mode `666`. Node on Windows can only express the
read-only bit; there is no owner-only ACL available through `fs`.

The contents are the problem, not the file. The server logs each step through
`logger.step(...)` *after* `${env.X}` interpolation, so a test whose step is
`Log in as ${env.BANK_USER} with ${env.BANK_PASSWORD}` writes the resolved
credentials into the log verbatim. On Windows that file is then readable by
every user on the box.

## Context

The log exists for a good reason: when an auto-started server fails to become
healthy, its output is the only diagnostic the agent (or the developer) can
see — the child is detached and its stdio goes nowhere else. Without it,
`autoStartFailed` would say "the server did not become healthy" and nothing
more.

Two mitigations are already in place and should not be mistaken for a fix:

- **The log tail quoted in a failure message is floored** at the offset this
  attempt started writing at ([039's sibling fix](../src/mcp/server-start.ts#L656)),
  so a failing start cannot quote an *earlier* server's steps into a tool
  result that reaches the model provider. That closes the egress-to-the-agent
  path. It does not change what is on disk.
- **`.steptix/` is gitignored**, so the file cannot be committed by accident.

What remains is local disclosure: any user on a shared Windows machine can
read another user's project log. Note this is not unique to the MCP path —
the same `logger.step` output goes to the terminal and to the per-run log file
under the existing `serverFileLogLevel` setting — but the MCP path is the one
that creates a long-lived file, unprompted, in the project directory, as a
side effect of an agent calling a tool.

## Decision (for now)

Keep `0o600` (free and correct on POSIX), keep the tail floor, and record that
the mode is not a mitigation on Windows. Do **not** cite the mode as the reason
it is safe to log resolved values — that inference is what this issue exists to
prevent.

## Options when picked up

1. **Redact at the source.** Have the server mask known secret values in
   `logger.step` output — the composed env is available at that point, so any
   value that appears in it can be replaced with `${env.NAME}` before logging.
   This is the real fix, it benefits every log sink rather than this one file,
   and it connects to the existing secret-masking work
   ([013](013-secret-masking-duplicated-and-divergent.md)). Cost: needs a
   value→name index per session and care with short or common values.
2. **Set a real ACL on win32.** Shell out to `icacls` after creating the file
   (grant the current user, remove inherited access), or use a native module.
   Ugly and platform-specific, but it makes `0o600`'s intent true everywhere.
3. **Move the log out of the project directory** to per-user storage
   (`%LOCALAPPDATA%`), which is at least not world-readable by default on a
   normal Windows setup, and drop the `.steptix/` directory entirely. Loses the
   "it's right next to the project" discoverability the current path was
   chosen for.
4. **Log less.** Run the auto-started server at `warn` — but the whole value
   of the file is diagnosing a server that failed to start, and that
   diagnosis lives in the startup output, not the step output. Would need to
   be level-scoped rather than blanket.

Option 1 is the one worth doing; option 3 is a cheap improvement that could
land independently.

## Revisit conditions

Pick up when: (a) the framework runs on a shared or multi-user Windows machine;
(b) secret masking ([013](013-secret-masking-duplicated-and-divergent.md)) is
picked up for any other reason — this should ride along; or (c) a project puts
genuinely high-value credentials in `.env` (this repo's own already qualifies:
banking and GitHub).

## Why this matters

The code says `0o600` and reads as though the file is protected. It is, on
half the platforms this project supports, and not on the one it primarily runs
on — a gap that is invisible at the call site and easy to rely on by mistake.
The measurement is recorded in a comment beside the call; this issue is so the
decision is findable by someone auditing what the tool writes to disk rather
than by someone reading that function.
