# Project notes

## Flick: one client

`flick-vscode/` is the Flick client — a chat panel inside VS Code for driving
the Sessions API with natural-language steps. Extension ID `pkent.flick-vscode`.

There used to be a second client, `flick/`, a standalone Tauri desktop app
(Svelte front end, Rust backend) built to [SPEC-FLICK.md](SPEC-FLICK.md). It was
removed in favour of the VS Code extension — see
[issue 049](issues/resolved/049-remove-flick-tauri.md). With it went the only
reason this repo needed a Rust/MSVC toolchain.

`SPEC-FLICK.md` stays: it is still the behavioural spec flick-vscode follows,
with a note marking which sections described the removed desktop shell.

## TestBench: one extension

`testbench-native/` is the TestBench VS Code extension — it uses VS Code's
native editor surface and hosts the multi-test runner. Extension ID
`pkent.testbench-native`.

There used to be a second variant, `testbench-monaco/` (extension ID
`pkent.testbench`), which hosted the editor inside a webview using Monaco.
It was removed in favour of the native variant — see
[issue 048](issues/resolved/048-remove-testbench-monaco.md).
If you still have `pkent.testbench` installed, uninstall it; it is no longer
built from this repo.

## TestBench: bump the patch version on every change

Whenever you change code that ends up bundled into the TestBench VS Code
extension (anything under `testbench-native/`, **and** anything under
`runner-core/` since that's a `file:` dep bundled into the extension's
`dist/`), bump the patch field in `testbench-native/package.json`
(e.g. `0.1.1` → `0.1.2`) as part of the same change.

The install/verify loop is then:

```powershell
cd c:\Projects\vibe\ai-ui-automation\testbench-native
npm run build
npm run package
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension testbench-native-<new-version>.vsix --force
```

Then reload the VS Code window. The Extensions panel will show the new
version number, which is how the user confirms the install actually picked
up the new code — without a bump, the installed copy and the stale one share
a directory name and there's no visible signal that anything changed.

Plain `code` from PowerShell on this machine resolves to the GUI exe, which
rejects `--install-extension`. Always invoke the CLI shim at the full path
above.

## Seed gitignored files into a new worktree

After creating a worktree (via `git worktree add` or the `EnterWorktree`
tool), the new directory only contains tracked files. The repo needs several
gitignored files/dirs to actually run — `.env` (API keys) and the four
`node_modules/` trees (root, `flick-vscode/`, `testbench-native/`,
`runner-core/`). Without them, nothing works and `npm install` × 4 costs
several minutes.

Run this script once, right after the worktree is created:

```powershell
c:\Projects\vibe\ai-ui-automation\scripts\init-worktree.ps1 `
    -Destination <full-path-to-new-worktree>
```

It copies (not symlinks/junctions) env files and build dirs from the main
checkout at `c:\Projects\vibe\ai-ui-automation`, so the worktree is
independent and safe if `package.json` diverges between branches.

Add `-SkipBuilds` to copy only the env files when you don't need the heavy
build artifacts (e.g. for a docs-only change).

**Then build `dist/` in the worktree** — the script does not copy it:

```powershell
cd <full-path-to-new-worktree>; npm run build
```

This matters because the package self-import `ai-ui-automation/tools` (used
by the fixture tools) resolves via the `exports` field + the *nearest*
`package.json` to `dist/tools/index.js` **under whichever package root the
importing file lives in**. For a worktree fixture that's the worktree's own
`dist/`, so the worktree's tests run the worktree's tool code — but only once
that `dist/` is built. `dist/` is gitignored, so a fresh worktree has none
until you build.

Do **not** try to junction/symlink `node_modules` back to the main checkout
to save time: it has no effect on that self-import (resolved by path, not via
`node_modules`), and a shared `node_modules` means a worktree `npm install`
writes through to main. Copying + a worktree-local `npm install` is correct
*and* fast (the install is incremental on top of the copied tree).
