# 049 — Retire the Tauri `flick/` desktop app; `flick-vscode/` is the surviving Flick client

**Status:** resolved — tree deleted 2026-08-19
**Area:** `flick/` (whole tree, 58 tracked files); [SPEC-FLICK.md](../../SPEC-FLICK.md); [CLAUDE.md](../../CLAUDE.md) §"Running Flick in dev mode (Windows)"
**Related:** [048 — retire testbench-monaco](048-remove-testbench-monaco.md) (same shape, one tree earlier); [041 — `classifyEngine` misreads modern Edge](../041-flick-classifies-modern-edge-as-unknown.md) (about **flick-vscode**, not this tree — stays open)
**Opened:** 2026-08-19

## Summary

We are keeping one Flick client, and it is [flick-vscode/](../../flick-vscode/) —
the chat panel that lives inside VS Code. `flick/`, the standalone Tauri
desktop app described by [SPEC-FLICK.md](../../SPEC-FLICK.md), is to be deleted
from `main`.

The two have been carried side by side since flick-vscode was written. That was
never a variant split like [048](048-remove-testbench-monaco.md)'s two
TestBench extensions — flick-vscode is, by its own README, "a fresh, independent
reimplementation … no code is shared with the Tauri `flick/` project". Two
independent clients against the same Sessions API, and only one of them is
being developed.

## Why now

**flick-vscode has moved on; the Tauri app has not.** Both trees show 17
commits in the last 180 days, but they are not the same 17:

| | `flick/` (Tauri) | `flick-vscode/` |
| --- | --- | --- |
| Last feature/fix | `0aa6fe7`, 2026-04-20 | `2a92c04`, 2026-08-19 |
| Everything since | dependency bumps only (`aefd57a`, `9aa82e6`, `cc4fd3e`) | CDP attach, output sectioning, machine key, harness fix |
| CDP attach ("Adopt") | — | `2d2e07b`, `d4a6582` |
| Sectioned outputs + delta filter | — | `2026d64` |
| Tests | 0 files | 18 (unit + VS Code integration + live) |

Since April the Tauri app has received nothing but `npm audit` remediation —
carrying cost, not work.

**It fell off the machine-key path.** `af1145b` made `AIUI_SERVER_API_KEY` a
machine-level secret the framework provisions for itself, and updated the MCP
server, `aiui stop`, both TestBench extensions and flick-vscode. It did not
touch `flick/`. The Tauri app still expects a hand-typed `x-api-key` in its
settings modal (`flick/src/lib/api/client.ts:19`), so it only reaches an
authenticated server if the user goes and pastes the
generated key out of `%LOCALAPPDATA%\aiui\.env`. Every future auth change has
the same shape: three clients updated, one quietly left behind.

**It costs a second toolchain.** `flick/run-dev.bat` exists solely to source
MSVC's `vcvarsall.bat x64` so Rust's linker picks up MSVC's `link.exe` rather
than Git-for-Windows's — a Windows-specific workaround that the *first section
of [CLAUDE.md](../../CLAUDE.md)* is spent explaining. The worktree seeding script
budgets ~5 GB largely for `flick/src-tauri/target`. flick-vscode needs `npm`
and nothing else.

## What is lost

- **Speech-to-text mic button** — `flick/src/lib/components/InputBox.svelte`
  (`0a90e23`), a Web Speech API (`webkitSpeechRecognition`) push-to-talk on the
  input box. This is the one feature with no flick-vscode equivalent. It is a
  webview feature rather than a Tauri one, so it is re-implementable in
  flick-vscode's webview if we want it back.
- **Standalone-window behaviours** — bottom-right anchoring, upward expansion
  animation, always-on-top pin, dynamic window title. flick-vscode already
  dropped these *deliberately* (README §"Deliberate adaptations from
  SPEC-FLICK.md"); its answer is VS Code's **Move into New Window** to float the
  panel.
- **The Rust command layer** — `src-tauri/src/commands/{history,screenshots,
  sessions,settings,window}.rs`. flick-vscode's equivalent is the extension's
  global storage directory.
- **Nothing else.** No shared code, no shared fixtures, no test corpus roots,
  not a workspace member, and nothing under `src/` imports it.

## What removal touches

Beyond `git rm -r flick/`:

- [.gitignore:26-29](../../.gitignore#L26) — the `# Flick (Tauri app)` block.
  `.flick/` (line 38) and `flick-vscode/*.vsix` (line 39) **stay**: those are
  flick-vscode's CDP launcher profiles and its packaging output.
- [CLAUDE.md:3-18](../../CLAUDE.md#L3) — the whole "Running Flick in dev mode
  (Windows)" section goes; and :64-65, where the worktree note names
  `flick/src-tauri/target/` and "a Tauri rebuild".
- [scripts/init-worktree.ps1:9,60-61,89](../../scripts/init-worktree.ps1#L60) — two
  `$dirs` entries, the "~5 GB" comment, and the `-SkipBuilds` message's "rebuild
  Tauri as needed".
- [SPEC-FLICK.md](../../SPEC-FLICK.md) — **kept**, with a status note at the top.
  flick-vscode's README links it as the behavioural spec it still follows;
  deleting it would orphan that link and throw away the spec of the surviving
  client. The Tauri-specific §Window Behavior and §Technology stay as written,
  marked as describing the removed implementation.
- [flick-vscode/README.md:5-6](../../flick-vscode/README.md#L5) — "no code is
  shared with the Tauri `flick/` project" needs the past tense.

Nothing in `src/`, `runner-core/`, `testbench-native/`, the root
`package.json`, `tsconfig.json`, `vitest.config.ts` or `aiui.config.json`
references the tree, and there is no CI to update.

## What stays as written

- **"Flick step" terminology** — [src/runner/interactive-repl.ts](../../src/runner/interactive-repl.ts),
  [runner-core/src/repl.ts](../../runner-core/src/repl.ts), [SPEC.md:191](../../SPEC.md#L191),
  `stories/full-self-driving-supervised.md`. That is the REPL's name for an
  ad-hoc natural-language step typed against a live page. It names a concept,
  not either client, and survives the deletion untouched.
- **[041](../041-flick-classifies-modern-edge-as-unknown.md) stays open.** Its Area
  is `flick-vscode/src/extension/cdp-discovery.ts` — the *surviving* tree.
  Removing the Tauri app neither fixes nor moots it. Its phrase "pending a
  decision on flick's future" is about the flick-vscode copy converging on
  `GET /cdp/browsers`; a dated note is added there so this issue's resolution is
  not misread as closing it. Same phrasing appears in
  [src/browser/cdp-discovery.ts:7-8](../../src/browser/cdp-discovery.ts#L7), which
  already names flick-vscode explicitly and needs no change.
- **Historical prose in shipped documents** — `stories/cdp-connection.md:95`
  ("**Flick (Tauri)** — invokes the Node runner from its Rust backend"),
  `testbench-native/PLAN.md:26,104` ("sibling of `flick/`"),
  `SPEC-openai-client-migration.md:193` ("the Tauri (Flick) Node side"). Per
  [048](048-remove-testbench-monaco.md)'s precedent, shipped stories
  and plans are a record of what was true; rewriting them falsifies the record.
- **`docs/zip-project-prompt.md:23`** — its "Rust `target/`, Tauri
  `src-tauri/target/`" is an *e.g.* inside reusable generic guidance, not a
  claim about this repo's layout.

## Decision

Delete the tree. One commit that also lands the reference updates above, so
`main` is never in a state where a config points at a directory that isn't
there.

## Before deleting

- The app shipped as a bare executable with no installer, so there is nothing to
  uninstall — but a stray `flick.exe` someone still runs will not be rebuildable
  from `main`. This is a git deletion, not a shred; the history has the source.
- No `flick/src-tauri/target` exists on this machine, so there is no Rust build
  cache to reclaim. `flick/node_modules` is ~70 MB.
- Confirm no branch or worktree holds in-flight Tauri work worth landing first.

## Revisit conditions

Reopen if we need a Flick surface for someone who does not run VS Code. That
would be an argument for shipping the *same* webview UI in a standalone shell,
though — not for restoring a second, independently hand-written client.

## Resolution — 2026-08-19

Done in one commit on `chore/remove-flick-tauri`. 58 tracked files deleted,
plus ~70 MB of ignored artifacts (`flick/node_modules`, `flick/dist`) cleared
from disk. There was no `src-tauri/target` on this machine, so the Rust build
cache the worktree script had been budgeting for did not actually exist. Every
reference update listed above landed in the same commit, so `main` is never in
a state where a config points at a directory that isn't there.

Checked before deleting: five commits touching `flick/` exist on branches not
merged into `main` (`bc57274`, `eaeb7e7`, `8cddc43`, `c473c32`, `6701dae`), all
on stale `claude/*` branches. They are the un-squashed originals of merged PRs
#2, #3, #4, #6 and #7 — `main` already carries that work and is ahead of each
branch. Nothing in flight was lost.

Two things came out differently from the plan:

**`SPEC-FLICK.md`'s status note covers more than two sections.** The plan said
Window Behavior and Technology were the only parts describing the removed
shell. Reading it through, the Overview's "the project lives at `flick/`" and
the `{app_data}/flick/` paths under local persistence do too, so the note names
those as well rather than claiming a tidier split than the document has.

**CLAUDE.md gained a section instead of just losing one.** Deleting "Running
Flick in dev mode (Windows)" would have left the repo with no note saying which
Flick is the Flick. It is replaced by a short "Flick: one client" section in the
same shape as the existing "TestBench: one extension" — the two removals now
read the same way.

While the worktree instructions were open, two stale numbers were corrected:
`npm install` × 6 is now × 4 (root, `flick-vscode/`, `testbench-native/`,
`runner-core/` — the 6 predates [048](048-remove-testbench-monaco.md) as well),
and the "~5 GB" full-seed estimate, which was mostly Rust target, is now the
measured ~1.1 GB of node_modules.

[041](../041-flick-classifies-modern-edge-as-unknown.md) **stays open** and
carries a dated note saying so, because the removal makes its title
("flick's `classifyEngine`") read as if this closed it. It does not — 041 is
about flick-vscode.

Verified after the deletion: `tsc --noEmit` clean, root vitest 2524/2524 across
125 files.
