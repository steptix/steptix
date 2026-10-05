# 048 — Retire `testbench-monaco`; `testbench-native` is the surviving variant

**Status:** resolved — tree deleted 2026-08-19
**Area:** `testbench-monaco/` (whole tree, 50 tracked files); [CLAUDE.md](../../CLAUDE.md) §"TestBench: two extension variants"
**Related:** [017 — monaco integration tests silently no-op](017-testbench-monaco-integration-tests-dont-run.md); [035 — step-line-span parser duplicated six times](../035-step-line-span-parser-duplicated-six-times.md); [013 — secret masking duplicated and divergent](../013-secret-masking-duplicated-and-divergent.md)
**Opened:** 2026-08-19

## Summary

We are keeping one TestBench VS Code extension, and it is
[testbench-native/](../../testbench-native/). `testbench-monaco/` — the original
variant that hosts the editor inside a webview using Monaco — is to be deleted
from `main`.

The two have been carried side by side since the native rewrite (different
extension IDs, `pkent.testbench` vs `pkent.testbench-native`, so both VSIXes
can be installed at once). That was the right call while native was catching
up. It has caught up and gone past, so the second tree is now pure carrying
cost.

## Why now

**Native is a functional superset.** Monaco's webview reimplements, in
hand-written JS, what native gets from VS Code itself:

| monaco (webview) | native (VS Code surface) |
| --- | --- |
| `webview/lib/breakpoint.js` | `contributes.breakpoints` + real debug UI |
| `webview/lib/gutter-menu.js`, `gutter-rightclick.js` | native gutter + context menus |
| `webview/lib/line-tracking.js`, `selection-lines.js` | native selection/document API |
| `webview/lib/status-cleanup.js`, `runnable-trim.js` | `decorations.ts` |

…and native additionally has the multi-test runner (`test-controller.ts`,
`test-discovery.ts`, `runner-view.ts`), server lifecycle
(`server-manager.ts`, `server-status-bar.ts`, `server-commands.ts`),
`aiui.config.json` validation, section diagnostics, a definition provider and
a call-stack view. Monaco has nothing native lacks.

**Monaco's tests have not been running.** [017](017-testbench-monaco-integration-tests-dont-run.md)
established that `npm run test:integration` in monaco returns exit 0 in ~20s
because the suite's `run()` is never called — an unknown-length window with no
integration coverage at all, diagnosed but never fixed. Native's suite runs and
reports.

**It still takes maintenance.** 13 commits touched `testbench-monaco/` in the
last 90 days (vs 45 for native), and they are follow-the-leader changes, not
feature work — the most recent being `d2eb293`, *"Harden testbench-monaco's
runner too — it was the last silent pass"*. Every hardening pass, every
runner-core contract change, has to be applied twice.

**It is one of the duplicate copies.** Monaco carries its own `sections.ts`
span-scanner copy, one of the six [035](../035-step-line-span-parser-duplicated-six-times.md)
counts, guarded by a bespoke `tests/sections-copy-parity.test.js`. Deleting the
tree removes a copy and its guard together.

## What removal touches

Beyond `git rm -r testbench-monaco/`, these tracked references need updating:

- [.gitignore:32-33](../../.gitignore#L32) — `testbench-monaco/.vscode-test/` and `testbench-monaco/*.vsix`
- [CLAUDE.md:23,34,39](../../CLAUDE.md#L23) — the "two extension variants" section collapses to one; the patch-bump rule and install/verify loop lose their `<variant>` substitution
- [runner-core/tests/regression-corpus.test.js:59](../../runner-core/tests/regression-corpus.test.js#L59) — drop `testbench-monaco/tests/integration/fixtures` from `CORPUS_ROOTS`. Safe: monaco's only two fixtures, `plain.md` and `test-with-steps.md`, are byte-identical to native's files of the same name, and native's root contributes ten more. The corpus loses no coverage.
- [scripts/init-worktree.ps1:63](../../scripts/init-worktree.ps1#L63) — `testbench-monaco/node_modules` from the copy list
- Six issue files and six `stories/*.md` mention it in prose. Historical
  references (017, 013, 021, 034, 035, 036) should stay as written — they are a
  record of what was true. The `stories/` mentions want a read-through.

Nothing under `src/`, `docs/`, `README.md`, or the root `package.json`
references monaco, and it is not a workspace member — the tree is genuinely
standalone.

## What is not lost

- `testbench-monaco/stories/interactive-input-and-fsd.md` is **byte-identical**
  to `testbench-native/stories/interactive-input-and-fsd.md`. Verified with
  `diff`. Nothing to rescue.
- `tests/sections-copy-parity.test.js` only guards monaco's own copy against the
  frozen tables in `fixtures/sections/classification.json`; runner-core and the
  root suite assert against those same tables independently. The guard goes away
  with the thing it guards.
- The regression corpus keeps every shape it had — see the `CORPUS_ROOTS`
  note above; both monaco fixtures are duplicates of native's files of the
  same name.
- `testbench-monaco/SPEC.md` and `PLAN.md` describe the webview architecture. If
  we want the Monaco-in-webview approach on record, the history has it — this is
  a git deletion, not a shred.

## Decision

Delete the tree. Do it as one commit that also lands the reference updates
above, so `main` is never in a state where a config points at a directory that
isn't there.

On removal, close [017](017-testbench-monaco-integration-tests-dont-run.md) as
won't-fix into `issues/resolved/` — the tests it describes will no longer exist.

## Before deleting

- Anyone with `pkent.testbench` installed should uninstall it; without the
  source tree there is no way to rebuild that VSIX from `main`.
  `code --uninstall-extension pkent.testbench`.
- Confirm no local branch or worktree has in-flight monaco work worth landing
  first. `.claude/worktrees/errands-build/` currently holds a copy.

## Revisit conditions

Reopen only if the native editor surface turns out to block something the
webview made possible — arbitrary custom rendering inside the document is the
obvious candidate. That would be an argument for a webview *panel* in native,
though, not for resurrecting a second extension.

## Resolution — 2026-08-19

Done in one commit on `chore/remove-testbench-monaco`. 50 tracked files
deleted, plus ~735 MB of ignored build artifacts (`node_modules/`, `dist/`,
`.vscode-test/`, four built `.vsix` files) cleared from disk. All four
reference updates listed above landed in the same commit, so `main` is never
in a state where a config points at a directory that isn't there.

The `stories/` mentions were read through and **left as written**, per the
decision above — all six are scoping or state-of-the-world notes inside
already-shipped stories (`json-config-migration` non-goals,
`machine-key`'s resolution table, `output-source-tagging`'s out-of-scope
section, `project-scoped-data-dir-and-env`'s mirror note,
`server-lifecycle`'s packaging exception, `test-script-sections-contract`'s
fixture-path table). Two carry now-dead relative links into the deleted
tree; rewriting shipped stories would falsify the record, so they stand as
history.

One drive-by fix while the packaging instructions were open: CLAUDE.md's
install command said `testbench-<new-version>.vsix`, but `vsce` emits
`testbench-native-<new-version>.vsix`. Harmless while the line was a
`<variant>` template; wrong once it named native specifically. Corrected.

[017](017-testbench-monaco-integration-tests-dont-run.md) closed as
won't-fix in the same commit.
