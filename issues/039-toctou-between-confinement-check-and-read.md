# 039 — Roots confinement checks a path, then reads it again by path (TOCTOU)

**Status:** open / security — accepted; the window is narrow and the attacker
already needs write access inside an allowed root.
**Area:**
[src/mcp/project.ts:131](../src/mcp/project.ts#L131) (`canonicalize` — realpaths the deepest existing ancestor);
[src/mcp/project.ts:150](../src/mcp/project.ts#L150) (`confinePath` — the check every rule funnels through);
[src/mcp/project.ts:169](../src/mcp/project.ts#L169) (`canonicalTestFilePath` → later `fs.readFile` in [assemble.ts](../src/mcp/assemble.ts));
[src/mcp/project.ts:376](../src/mcp/project.ts#L376) (`.env.<name>` confined, then `readEnvFileVars` re-resolves it by path);
[src/mcp/project.ts:490](../src/mcp/project.ts#L490) (base `.env` confined, then `readDefaultEnvVars` re-resolves by path);
`findConfigUpward` → `readProjectConfig` (same shape).
**Related:** [stories/mcp-server.md §4a](../stories/mcp-server.md) (the six
confinement rules), [038](038-server-identity-is-a-public-constant.md).
**Opened:** 2026-07-24

## Summary

Every confinement rule in §4a is *check-then-read-by-path*: we `realpath` a
path, assert the result sits inside an allowed root, and then hand the
**original path string** to a separate function that resolves it again. Between
those two resolutions the filesystem can change. Swap a real file for a symlink
in that window and the read follows the symlink, out of the root — after the
check said it was inside.

Concretely, for the file whose contents matter most: `.env` is confined at
[project.ts:490](../src/mcp/project.ts#L490), then `readDefaultEnvVars`
re-opens `<root>/.env` by path. A process that replaces `<root>/.env` with a
symlink to `~/.aws/credentials` between those two calls gets the target parsed
as `KEY=VALUE`, shipped to the server as the request's `env` field,
interpolated into step text, and written into the HTML report.

## Context

The confinement rules themselves are sound and were adversarially reviewed —
symlink escape, `C:\proj-evil` against `C:\proj`, win32 case and 8.3 names,
the bounded config walk, config-derived paths, and the `env_name` charset were
each attacked on paper and each held. This issue is not a hole in a rule; it is
a property of the *shape* all six share.

What an attacker needs, and why that tempers it:

- **Write access inside an allowed root.** By that point they can also simply
  put their content in the real `.env`, or add a `toolsDir` entry, or edit a
  test — all of which the framework will happily execute or interpolate,
  because running project-authored code and reading project-authored env is
  the product's whole job.
- **To win a race measured in microseconds**, repeatedly, without being
  noticed.

So the realistic escalation is narrow: it turns "can influence this project's
own files" into "can exfiltrate a file from outside the project" without
leaving that content in a file the developer would see in `git status`. Not
nothing — but strictly less than the access already required to attempt it.

The one place the framing is less comfortable is a prompt-injected agent: an
agent that has been talked into writing a symlink inside the workspace is a
plausible 2026 scenario, and it has the write access the attack needs.

## Decision (for now)

Accept, and record. Closing it means carrying file descriptors through the
whole path — which is a different design, not a patch (below).

## What a fix actually requires

The check and the read must observe the *same* filesystem object, which means
passing a descriptor rather than a string:

1. `open()` the target once (`O_RDONLY`; on POSIX add `O_NOFOLLOW` for the
   leaf so a symlinked leaf is refused outright rather than resolved).
2. Derive the real path from the descriptor — `fs.realpathSync('/proc/self/fd/N')`
   on Linux, `F_GETPATH` on macOS, `GetFinalPathNameByHandle` on Windows
   (Node exposes none of these portably, which is the crux).
3. Confine *that* path.
4. Read from the **descriptor**, never re-resolving the string.

Every current reader would need an fd-taking variant: `readDefaultEnvVars`,
`readEnvFileVars`, `readProjectConfig`, and the test-file read in
`assemble.ts`. The directory walk (`findConfigUpward`) has the same problem one
level up and would want `openat`-style traversal, which Node does not offer at
all.

Cheaper partial mitigations, if the full fix is not justified:

- **`O_NOFOLLOW` on the leaf** for `.env`, `.env.<name>` and `aiui.config.json`.
  Refuses a symlinked leaf entirely, which kills the specific attack above
  while leaving symlinked *directories* (the legitimate "one `.env` shared
  across checkouts" case the As-built note cites) working. POSIX-only —
  Windows has no equivalent flag, and Windows is this project's primary
  platform.
- **`fstat` the descriptor after opening and compare `dev`/`ino` to a `stat`
  taken at check time.** Detects the swap after the fact rather than
  preventing it, but turns a silent exfiltration into a refusal. Also
  POSIX-flavoured; on win32 the equivalent is the file index from
  `GetFileInformationByHandle`.

## Revisit conditions

Pick up when: (a) the MCP server is run against roots that are not the
developer's own trusted checkouts (shared workspaces, agent sandboxes with
partial write access, anything auto-cloned); (b) Node gains a portable
fd→path or `openat` API making the real fix cheap; or (c) a related issue
forces a rewrite of the readers anyway — do it then, since the cost is mostly
in threading descriptors through code that currently passes strings.

## Why this matters

§4a's six rules are the security boundary of the whole MCP server, and they
read as airtight — each is individually correct. It is worth having on record
that they share a structural weakness none of them shows on its own, so a
future reviewer who checks the rules and finds them sound does not conclude
the boundary is closed.
