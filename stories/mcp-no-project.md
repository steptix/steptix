# No project — driving your own browsers from a prompt

## In plain terms

The MCP server today can only work inside a project. Every tool call walks
upward looking for `steptix.config.json`, and if it doesn't find one the call is
refused before it does anything — not just `run_steps`, but
`list_cdp_browsers` and `server_status` too. So the moment you're not sitting
in a repo that has a config file, the whole server does nothing.

That's the wrong shape for how it's actually being used. A lot of the time
there is no test file and no project. You're just talking to an agent: *"show
me my openrouter tab"*, *"check whether I'm still logged into the admin
console"*. Nothing about that is project-shaped.

The same anchor causes a second problem even when there *is* a project.
Browsers are recorded as belonging to a project root — `.steptix/cdp-profiles/`
under that exact directory — so the signed-in Chrome you've been using all
week stops being yours the moment you work from a git worktree, a sibling
repo, or no repo at all. Same machine, same browser, same you.

This story separates the two things that are currently fused:

- **Your browsers and your credentials are yours, machine-wide.** They live in
  a user root outside any repo, and they're reachable from anywhere.
- **Skills, tools and test files stay with their project.** Those genuinely
  are project-shaped, and nothing here changes them.

Both roots are always in play. A profile name resolves against whichever root
actually has it, and when both do you get asked which one you meant rather
than a guess.

### What it looks like in practice

**You say:** *"What browsers do I have open?"* — from a directory with no
project in sight
**You get:** the list, instead of *"No steptix.config.json found, so there is no
project to run against."*

**You say:** *"Show me the openrouter tab"*
**You get:** that tab brought to the front. Works the same in your repo, in a
worktree of it, and in your home directory.

**You say:** *"Log into the admin console and tell me how many pending orders
there are"* — still no project
**You get:** the steps run in your own signed-in browser, and the answer.

**You say:** *"Run the checkout suite"* — now inside the project
**You get:** the project's `chrome-default` profile, exactly as today. The
project still wins for its own profile names.

**You say:** *"Use my personal Chrome for this one"* — inside the project
**You get:** your user-root browser, because you can address it explicitly
from anywhere. Today there's no way to say this at all.

**You say:** *"Run this step: `[tool: fetchOrders]`"* — with no project
**You get:** a refusal naming the reason — tools are code, code belongs to a
project, and no project resolved. Not a confusing failure three layers down.

> **Verification rule for this story.** "Done" means: (1) from a directory
> with no `steptix.config.json` anywhere above it, `list_cdp_browsers`,
> `start_cdp_browser`, `focus_cdp_tab` and `close_cdp_tab` all answer instead
> of failing preflight; (2) `run_steps` completes project-less against a real
> page, including `get_page_content` with `format: "screenshot"`, with the
> model and server read from the user root; (3) a browser started project-less
> is still `running` and still signed in after the MCP host restarts, the
> Sessions API server idles out, and the working directory changes — the
> proof that ownership is on disk and not tied to a project; (4) the same
> browser is `running` (not `foreign`, not withheld) when listed from inside
> a project, from a worktree, and from an unrelated directory; (5) a project
> that has its own `chrome-default` and a user root that also has one produces
> an ambiguity refusal naming both, never a silent pick, and `scope` settles
> it; (6) a `[skill:]` or `[tool:]` step in a project-less run is refused with
> a message that says why, and no global skills or tools directory is ever
> consulted; (7) every run result says which root it ran against, so a silent
> fallback caused by a typo'd config filename is visible rather than
> mysterious; (8) `mcp.cdp.allowUnowned` set in a project does **not** widen
> reach for project-less calls, and vice versa.

## Context

### What exists, and where each path dead-ends

| Capability | Status | Where |
| --- | --- | --- |
| Resolve a project from cwd / `project_root` / `STEPTIX_MCP_ROOTS` | ✅ shipped | [project.ts:444](../src/mcp/project.ts:444) |
| Refuse when no `steptix.config.json` is found | ✅ shipped — and this is the blocker | [project.ts:489](../src/mcp/project.ts:489) |
| `STEPTIX_SERVER_URL` / `STEPTIX_SERVER_API_KEY` falling back to `process.env` | ✅ shipped | [project.ts:360](../src/mcp/project.ts:360) |
| Prove browser ownership from disk, not memory | ✅ shipped | [cdp-registry.ts:240](../src/browser/cdp-registry.ts:240) |
| Ownership scoped to exactly one root | ✅ shipped — and this is the second blocker | [cdp-registry.ts:156](../src/browser/cdp-registry.ts:156) |
| Any tool working with no project at all | ❌ nothing | every tool goes through `resolveProject` |
| Addressing a browser that lives outside the current project | ❌ nothing | `knownProfiles` takes one `projectRoot` |

The refusal is upstream of everything. `resolveProject` is step one of every
tool body, so there is no partial mode today — no "browser verbs work but runs
don't". It's all or nothing, and it's currently nothing.

### What a project is actually supplying

Four unrelated things, fused into one path:

| Supplies | Genuinely project-shaped? |
| --- | --- |
| `STEPTIX_SERVER_URL`, `STEPTIX_SERVER_API_KEY` | No — already falls back to `process.env` |
| `.steptix/cdp-profiles/` — the browsers | **No** — personal and machine-scoped |
| `skillsDir`, `toolsDir`, `.env` interpolation | Yes — these are the project's code |
| `mcp.cdp.allowUnowned` | Yes — a human's decision about one project |

That's the fault line the whole story turns on. Two of the four are personal
and only accidentally live in a repo.

## The user root

A directory outside any project, holding the same things a project root holds:

```
%LOCALAPPDATA%\steptix\           (Windows)
$XDG_CONFIG_HOME/steptix/  or  ~/.steptix/     (everywhere else)
├── steptix.config.json
├── .env
└── .steptix/
    └── cdp-profiles/
        └── chrome-default/
            ├── .steptix-profile
            └── DevToolsActivePort
```

Identical layout on purpose — `cdpProfilesRoot()` and `knownProfiles()` work
against it unchanged, and the ownership proof stays exactly what it is today:
a port that traces back to a profile directory we made. No new trust model,
no marker-scanning of arbitrary paths, no registry in memory. Note the nested
`.steptix/cdp-profiles/` — the user root is a *real* project root, so it carries
the same `.steptix/` subdirectory a project does (the browsers live at
`%LOCALAPPDATA%\steptix\.steptix\cdp-profiles\`, and the auto-start log at
`%LOCALAPPDATA%\steptix\.steptix\mcp-server.log`). "Same layout" is the whole point:
one `cdpProfilesRoot(root)` serves both.

Created on first use, not on install. A machine that never runs a project-less
call never grows the directory.

**It must be added to `allowedRoots()` implicitly.** `confinePath` is the
security boundary of the MCP server, and a user root that isn't in the allowed
set would be refused by the very next call — so this is not optional plumbing,
it's part of the change.

## Two scopes, both always swept

`knownProfiles(projectRoot)` becomes `knownProfiles(roots)`, where `roots` is
the user root plus the project root when one resolved. Everything downstream
follows from that one generalisation:

- `resolveCdpOwner` reports `owned: true` when **any** root's live profile
  holds the port, and carries a `scope` saying which.
- `foreign` shrinks to its true meaning: a browser tracing back to *neither*
  root. Your own personal Chrome stops being foreign to your own project.
- `list_cdp_browsers` reports `scope` on every entry, so an agent can tell
  "the suite's admin login" from "my everyday browser" without guessing.

### How a profile name resolves

A profile name alone resolves against both roots:

- Exactly one root has it → that one, no ceremony.
- Both have it → **refused**, naming both addresses. This is the same rule
  `cdpProfileAmbiguous` already applies to a name that exists on both Chrome
  and Edge ([cdp.ts:149](../src/mcp/cdp.ts:149)), for the same reason: the
  wrong pick is a browser signed in as somebody else.
- Neither has it → the existing not-running error, now listing candidates from
  both roots.

An explicit `scope: "project" | "user"` settles ties and states intent. It is a
separate field rather than part of the name because `PROFILE_NAME_PATTERN`
refuses `/` — the name is a path component that later feeds a recursive
delete, and that guard stays ([cdp-registry.ts:189](../src/browser/cdp-registry.ts:189)).

This is what makes an address mean the same thing everywhere. `scope: "user"`,
`profile: "default"` is your browser from any directory on the machine,
forever.

## What project-less mode does and does not get

**Does:** all four CDP verbs, `run_steps`, `get_page_content` (including
`format: "screenshot"`), `list_sessions`, `close_session`, `get_last_run`,
`server_status`, `get_run_settings`. The model, server URL and API key come
from the user root's config and `.env`, with the existing `process.env`
fallback underneath.

**Does not:** skills, tools, or test files. `[skill: …]` and `[tool: …]` steps
are refused in project-less mode with a message that names the reason, and
`list_test_files` / `run_test_file` still require a project.

That exclusion is the point, not an omission. A machine-global tools directory
would mean any conversation, in any directory, can execute code from a path
that no repo owns and no review covers. The whole value of `toolsDir` being
project-scoped is that it's confined to a project someone chose.

## The user root's `.env`

The `STEPTIX_SERVER_API_KEY` half of that file is
[machine-key.md](machine-key.md)'s job, and that story ships first. By the
time this one lands, the user root's `.env` already exists and already holds
the machine key, written by whichever process needed one first. This story
adds nothing to how the key works — it inherits the file and the resolution
chain as they are, and widens the *directory* around them into a full root.

What this story does add:

- **`STEPTIX_SERVER_URL` for project-less runs**, defaulted to loopback on a
  distinctive port, not 3100. Loopback it must be anyway — auto-start only
  ever spawns on a loopback host (§5 arm 4) — and a distinctive port avoids
  colliding with the project server people already run on 3100, which
  auto-start would refuse as an unrecognized service.
- **The zero-file path stays open.** `STEPTIX_SERVER_URL` and `STEPTIX_SERVER_API_KEY`
  set in the MCP host config's `env` block (where `STEPTIX_MCP_ROOTS` lives
  today) are picked up by the `process.env` step with nothing on disk at
  all.

## Locked decisions

- **The `.env` may be machine-written ([machine-key.md](machine-key.md)'s
  rule); the `steptix.config.json` never is.** The `.env` holds a loopback
  secret that grants nothing outside the machine. The config holds
  `allowUnowned`, which is a *permission* — and a machine-global one applies
  in every conversation, forever, with no repo to scope or review it. First
  run stays zero-friction; widening reach stays something a human types.

- **The user root is a real project root, not a special case.** Same file
  layout, same loader, same ownership proof. A parallel "global mode" with its
  own rules is how the two paths start disagreeing about what `default` means.

- **Both roots are always swept; the name resolves against both.** Not
  "project wins, user is a fallback" — that reintroduces the bug, because the
  same words would mean different browsers depending on which directory the
  host happened to start in.

- **Ambiguity is refused, never resolved by precedence.** Inherited from the
  engine-ambiguity rule already in `resolveCdpTarget`.

- **`scope` is a field, not a prefix on the name.** Slashes stay illegal in
  profile names because that guard protects a recursive delete.

- **`allowUnowned` is read from the config of the root the call resolved
  against, and the two are independent.** A project can widen its own reach
  without widening every project-less conversation on the machine, which is
  the strictly more dangerous grant — it applies everywhere, forever, with no
  repo to scope or review it.

- **The fallback to the user root is reported, never silent.** A mistyped
  config filename currently produces a clear "no project" error; after this
  change it would otherwise produce a *working* run against the wrong root,
  with the project's skills mysteriously absent. Every result says which root
  it used.

- **No global skills or tools directory.** See above.

## Not in this story

- **The machine key itself.** How `STEPTIX_SERVER_API_KEY` is generated, where
  it lives, and who reads it is [machine-key.md](machine-key.md) — reviewed
  and implemented first, on its own.

- **Screenshotting a CDP tab without binding a session to it.** That gap is
  real — `get_page_content` takes a `session_id` and there's no way to say
  "photograph this `targetId`" — but it's orthogonal to where the project
  lives, and it needs its own story. Worth writing next: with
  `focus_cdp_tab` shipped, "show me the openrouter tab" works and "show me a
  *picture* of the openrouter tab" still costs a `run_steps` call and a
  model turn.

## Open questions — resolved in the build

- **Discovering the `allowUnowned` file.** An absent user-root
  `steptix.config.json` reads as "all defaults", since nothing may create it
  (§Locked). Resolved: the reach-refusal message names the exact config path
  for the *resolved scope* — a project's own file, or
  `%LOCALAPPDATA%\steptix\steptix.config.json` for a project-less call — and says
  "creating the file if it does not exist yet". That refusal is the discovery
  path.

- **`STEPTIX_MCP_ROOTS` with one entry.** Resolved: it still means "that's the
  project". The split is `configuredRoots()` (project *candidates* — the env
  var, or cwd) versus `allowedRoots()` (`configuredRoots()` **plus** the user
  root — the confinement/addressing allow-list). A project is only ever
  selected from `configuredRoots()`, so a single entry keeps behaving exactly
  as the machine-global hosts (Codex CLI, Copilot CLI) configure it; the user
  root joins only the allow-list, so it can be *addressed* (`scope: "user"`,
  `project_root: <userRoot>`) and is where resolution *lands* when no project
  does — never a project that competes for selection.

  A corollary the build had to get right: project *file-loading* (skills,
  tools, `.env`, `.env.<name>`, `tests.dir`, `dataSources`) is confined
  against `configuredRoots()`, **not** the wider allow-list. The user root
  joining the allow-list is for addressing only; letting a project's own
  untrusted `steptix.config.json` reach into `%LOCALAPPDATA%\steptix` through it
  would hand that config the machine key and a skills/tools directory no repo
  owns. The wide list confines only the two things that legitimately name the
  user root — the resolution arguments and a user-*scope* resolution's own
  files.
