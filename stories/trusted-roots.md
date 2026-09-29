# Trusted roots — approve a project once, on any host

> **Verification rule for this story.** "Done" means: (1) with no
> `STEPTIX_MCP_ROOTS` set, asking `run_test_file` for a path in a project that is
> neither the MCP server's cwd nor approved is refused with a message
> containing a **runnable** `steptix trust "…"` line, correctly quoted for a path
> containing spaces; (2) running that command once makes every later call in
> that project succeed — **on the next call, with no host restart** — and it
> keeps working after switching host (e.g. Claude Code → OpenCode) with no
> per-host configuration; (3) a project that *is* the MCP server's cwd still
> needs no approval at all, exactly as today; (4) `STEPTIX_MCP_ROOTS`, when set,
> still wins outright and the trust file is not consulted; (5) `steptix trust`
> on a directory containing the user's home directory prints a prominent
> warning naming what it exposes, and proceeds; (6) a trusted directory that
> has since been deleted is skipped without breaking the other entries, while
> a non-existent `STEPTIX_MCP_ROOTS` entry stays fatal.

## Context

§4a of [mcp-server.md](mcp-server.md) gives the MCP server exactly two
sources for its allow-list: `STEPTIX_MCP_ROOTS` if set, else the MCP process
cwd. Both are frozen when the host (e.g. Claude Code) spawns the process.
That was the right minimum for the first release, and it is the *only*
confinement in the system — the Sessions API server does no path checking of
its own, so a request that gets past the MCP server is unchecked from there
on.

The friction is real and reproducible. With this repo open in Claude Code and
test files living in `C:\Projects\AITests`, every MCP call is refused:

```
Refusing to touch "C:\Projects\AITests": it is outside every allowed root.
Allowed roots: C:\Projects\vibe\ai-ui-automation
```

The working directory is one value, fixed at spawn. No syntax makes it two
folders. Every fix available today is bad in a specific way:

- **`env` in the checked-in `.mcp.json`** — the value is an absolute path, so
  a committed one is wrong on every other clone. Already rejected in §4a.
- **`env` in each host's own config** — this project deliberately targets
  several hosts (the opencode-ai dialect workaround in
  [schemas.ts](../src/mcp/schemas.ts) exists because OpenCode is a real
  target), so that is four config files, four places to remember, four things
  to get wrong.
- **The MCP `roots` capability** — the protocol's own answer, but an
  *optional* client capability we have not implemented and whose support
  across Codex CLI / Cursor / OpenCode is unknown. Worth doing eventually;
  cannot be relied on.
- **Dropping confinement** — leaves nothing, per the first paragraph.

What makes a once-per-project approval the right price: the friction is a
**per-project** event (point at a project that is not cwd), while the
protection is against a **per-page-load** event. This framework drives
browsers across untrusted pages by design, and a page that talks the agent
into `run_test_file("C:\Users\…\.aws\config")` gets that directory's `.env`
shipped to whatever `SERVER_URL` it names, and its `toolsDir` JavaScript
executed. A human action once per project, against an attack surface that
reloads every few seconds, is a good trade.

## Locked decisions

- **The trust file lives in the user's home directory**, never in a project.
  A project-local file lets a project widen its own boundary, and an injected
  agent that can write files in the workspace could append `~/.ssh` to it.
  Home is outside every workspace the agent is working in.

- **Trusted roots are unioned with cwd, not a replacement for it.** The cwd
  was chosen by the host, not by the AI, and it is today's boundary. Union
  means (a) zero behaviour change for every existing setup, and (b) no
  approval prompt for the project you are actually in — the approval flow
  appears only when reaching *outside*, which is the only case that was ever
  friction.

- **`STEPTIX_MCP_ROOTS` wins outright; when set, the trust file is not read.**
  Codex CLI and Copilot CLI have the variable as their only configuration
  surface, and an explicit override silently unioned with a stale trust file
  is worse than one that means what it says.

- **Approval is our own CLI command, not a host prompt.** MCP elicitation
  would route through the host and inherit precisely the uneven support that
  makes the `roots` capability unreliable. `steptix trust` behaves identically
  no matter what launched the MCP server — and a web page cannot run it,
  which is the entire security property.

- **The trust file is read on every call, uncached.** `allowedRoots()` is
  already called per request and deliberately uncached. Keeping it that way
  is what lets `steptix trust` take effect on the *next tool call*. Caching
  would reintroduce the approve-then-restart-your-session cycle that makes
  the environment variable painful today, which would defeat the story. The
  read is a few hundred bytes at single-digit calls per minute.

- **Whole-drive trust warns loudly; it does not refuse.** `steptix trust C:\`
  proceeds after printing what it exposes. Refusing would push the user to
  `STEPTIX_MCP_ROOTS=C:\`, which is the same boundary with **no warning at
  all** — strictly worse, because it is silent. The warning is the value
  here; the refusal is not.

- **The warning triggers on containment, not on depth.** Warn when the
  resolved path is a filesystem root, *or* when it contains
  `os.homedir()`, *or* when it is `os.homedir()`. Counting path segments is
  arbitrary; "does this put `.ssh`, `.aws` and your browser profile inside
  the boundary?" is the question that matters, and containment answers it
  exactly.

- **The refusal message suggests a path but performs no walk.** It names
  `path.dirname(refusedPath)` and says "or a parent directory holding several
  projects". Walking upward to locate the nearest `steptix.config.json` would
  mean stat-ing paths *outside* the boundary purely to write a friendlier
  message — and §7 already reasons about not distinguishing "absent" from
  "outside your roots". The human is the right decider for which directory to
  approve, and they can edit the command before running it.

- **A missing trusted entry is skipped with a warning; a missing
  `STEPTIX_MCP_ROOTS` entry stays fatal.** Deleting an old project must not
  break the MCP server for every other project. An explicit environment
  variable naming a directory that does not exist is a configuration error
  and keeps today's `badRootEntry` behaviour.

## Design

### 1. The trust file

`path.join(os.homedir(), '.steptix', 'config.json')` —
`C:\Users\Paul Kent\.steptix\config.json` on this machine. `STEPTIX_CONFIG_HOME`
overrides the *directory*, which is how the tests get a sandbox and how a CI
account with an unusable home directory opts out.

```json
{
  "trustedRoots": ["C:\\Projects\\AITests"]
}
```

An object, not a bare array, so later fields do not force a format break.
**Unknown top-level keys are preserved across writes** — `steptix trust` must
not clobber a field written by a newer version of the tool.

Failure semantics differ by direction, deliberately:

- **Missing file** → empty list. Not an error; it is the normal state before
  the first approval.
- **Malformed file on read** → empty list, plus a warning carried into the
  refusal message. A corrupt file must not brick every tool call, but it must
  be *visible*, or trust silently stops working and nothing says why.
- **Malformed file on write** → `steptix trust` refuses. Overwriting a file we
  could not parse would discard whatever was in it.

### 2. `allowedRoots()`

[src/mcp/project.ts §allowedRoots](../src/mcp/project.ts) gains one branch:

```
STEPTIX_MCP_ROOTS set and non-empty  → exactly those entries      (unchanged)
otherwise                         → trustedRoots() ∪ [cwd]     (new)
```

Everything downstream is untouched: each entry still goes through
`fs.realpathSync.native`, still must be an existing directory, and the
segment-boundary / win32-case comparison in `isInsideRoot` is unchanged.
Canonicalise before deduping, or `C:\Projects\AITests` and
`C:\PROJ~1\AITests` both survive as separate entries.

The only new asymmetry is the failure semantics locked above: trust entries
that fail to resolve are dropped, `STEPTIX_MCP_ROOTS` entries that fail to
resolve still call `fail(badRootEntry(...))`.

### 3. `steptix trust`

A normal CLI command in `src/cli/commands/trust.ts`, registered from
[src/cli/index.ts](../src/cli/index.ts) alongside the others. (Unlike
`steptix mcp`, which bypasses the CLI per §1 of mcp-server.md, there is nothing
special about this one.)

```
steptix trust <path>     approve a directory
steptix trust --list     show approved directories
steptix untrust <path>   remove one
```

`trust <path>`:

1. Resolve and `realpathSync.native`. Must exist and be a directory, else a
   plain error — approving a typo silently is worse than failing.
2. Already present after canonicalisation → say so and exit 0. Idempotent,
   because the refusal message will be pasted more than once.
3. **Containment warning** (locked above) if it is a filesystem root, is the
   home directory, or contains it. Name the consequence concretely — *"this
   puts `C:\Users\Paul Kent\.ssh` inside the boundary"* — not an abstract
   caution. Proceed.
4. **No-project note** if there is no `steptix.config.json` directly in the
   directory. Phrased as information, not a warning: approving a parent that
   holds several projects is a legitimate and expected use.
5. Append, preserving unknown keys, creating `~/.steptix/` if needed.

### 4. The refusal message

[src/mcp/errors.ts §pathOutsideRoots](../src/mcp/errors.ts) keeps its first
two lines and replaces the third:

```
Refusing to touch "C:\Projects\AITests\tests\github with sections.md":
it is outside every allowed root.
Allowed roots: C:\Projects\vibe\ai-ui-automation

Approve the project once — this takes effect on the next call, no restart:
  steptix trust "C:\Projects\AITests\tests"
(or a parent directory holding several projects)

For machine-global hosts, STEPTIX_MCP_ROOTS still overrides this entirely.
```

The quoting is part of the contract, not cosmetic: the path that exposed this
whole problem is `github with sections.md`, and an unquoted suggestion is not
runnable. There is a test for exactly that.

### 5. Relationship to the `roots` capability

If the MCP `roots` capability is implemented later it slots in as another
layer — `STEPTIX_MCP_ROOTS` → host-supplied roots → trusted roots → cwd — and
removes the need to approve anything on hosts that support it. Nothing here
forecloses that. It is a separate story.

## Out of scope

- The MCP `roots` client capability (separate story).
- Any confinement in the Sessions API server. It has none today; adding some
  is a much larger change and its existing clients (CLI, Steptix) are
  trusted callers by design.
- Per-root scopes or permissions. Trust is all-or-nothing per directory.
- Expiring or auditing approvals.
- Any change to `STEPTIX_MCP_ROOTS` semantics.

## Composition

| File | Change |
|---|---|
| `src/config/user-config.ts` | **new** — read/write `~/.steptix/config.json`, unknown-key preservation, malformed handling. Not under `src/mcp/` because the CLI writes it too. |
| [src/mcp/project.ts](../src/mcp/project.ts) | `allowedRoots()` gains the union branch and the skip-missing-trusted-entry rule. |
| [src/mcp/errors.ts](../src/mcp/errors.ts) | `pathOutsideRoots` rewritten per §4. |
| `src/cli/commands/trust.ts` | **new** — `trust` / `--list` / `untrust`. |
| [src/cli/index.ts](../src/cli/index.ts) | `registerTrustCommand(program)`. |
| [stories/mcp-server.md](mcp-server.md) §4a | Amend the allow-list sentence to point here. |
| `README.md` | Host setup section: approve-once replaces "set this variable per host". |

## Tests

### Unit / seam (vitest)

In [tests/mcp-project.test.ts](../tests/mcp-project.test.ts) plus a new
`tests/user-config.test.ts`, all with `STEPTIX_CONFIG_HOME` pointed at a temp
directory:

- No env var, no trust file → cwd only. **This is the today-behaviour
  regression test** and it must not move.
- `STEPTIX_MCP_ROOTS` set *and* a populated trust file → exactly the env var's
  entries; the trust file is not read.
- Trust file + cwd → union, deduplicated after canonicalisation.
- A trusted entry that no longer exists → skipped; the remaining entries and
  cwd still resolve.
- A `STEPTIX_MCP_ROOTS` entry that does not exist → still fatal
  (`badRootEntry`).
- A trusted entry that is a symlink → realpath'd before comparison, so it
  cannot widen the boundary by pointing elsewhere later.
- Malformed trust file → reads as empty, warning surfaces; `steptix trust`
  refuses to overwrite it.
- Unknown top-level keys survive a `trust` write.
- `steptix trust` twice on the same path → idempotent, exit 0.
- `steptix trust` on a path containing `os.homedir()` → warns, still writes.
- **`pathOutsideRoots` on a path containing spaces emits a runnable, quoted
  command.**

### Live (manual)

1. With the repo open in Claude Code and nothing configured, ask for a test
   in `C:\Projects\AITests` → refused with the command.
2. Run the command in a terminal. **Without restarting the session**, ask
   again → runs.
3. Repeat step 2's success from a second host with no configuration there.

## Risks / open

- **The home directory is not a barrier against the agent itself.** Claude
  Code can write to `~/.steptix/config.json` if asked. The property this design
  actually provides is *visibility*: writing a trust file is a conspicuous,
  reviewable action, whereas reading a test file is routine. That is a raised
  bar, not a wall, and the story should not claim otherwise.
- **A user who trusts a parent of everything gets no protection.** By
  decision, the warning is the only guard. Accepted: the alternative pushes
  people to the silent environment variable.
- **Synced home directories** (OneDrive) can carry trust entries to a machine
  where the path means something else. The existence check makes them skip
  rather than mis-apply, but a same-path-different-content collision is
  possible in principle.
- **Open:** should `steptix trust --list` mark entries that no longer resolve?
  Cheap and useful, but it is the only place the CLI would need the skip
  logic from §2. Probably yes; not blocking.

# Plan

## Workstream graph

```
W1 user-config module
      ├──> W2 allowedRoots precedence ──> W4 refusal message ──> W5 docs
      └──> W3 steptix trust CLI ─────────────────────────────────┘
```

## Workstreams

**W1 — `src/config/user-config.ts`.** Read/write, path resolution including
`STEPTIX_CONFIG_HOME`, unknown-key preservation, the three failure semantics
from §1. Tests: `tests/user-config.test.ts`. No consumers yet.

**W2 — `allowedRoots()` precedence.** The union branch, canonical dedupe,
skip-missing-trusted vs fatal-missing-env. Tests extend
`tests/mcp-project.test.ts`, leading with the unchanged-behaviour case.

**W3 — `steptix trust` / `--list` / `untrust`.** Command module plus
registration; the containment warning and the no-project note. Independent of
W2 — the CLI writes the file, the MCP server reads it, and they meet only at
W1's module.

**W4 — refusal message.** `pathOutsideRoots` rewritten, including the quoting
test. Depends on W2 for the roots it reports.

**W5 — docs.** README host-setup section, §4a amendment in mcp-server.md
pointing here.

## Repo gotchas

- **Rebuild `dist/` before testing by hand.** The MCP server the host spawns
  runs `dist/index.js`, not `src/`. A change is not live until
  `npm run build` — this has bitten before.
- **The full vitest run is intermittently flaky** (a worker-pool crash that
  fails all files at once in ~8s with 0 tests). Re-run, or run the single
  file, before believing a regression.
- **`allowedRoots()` reads `process.env` and `process.cwd()` fresh on every
  call** specifically so tests need no module resets. Preserve that; the
  uncached read is also what §2's locked decision depends on.
