# Project notes

## Running Flick in dev mode (Windows)

On Windows, always invoke `flick/run-dev.bat` with its **full path**, not by
bare name:

```
cmd //c "c:\Projects\vibe\ai-ui-automation\flick\run-dev.bat"
```

The bare-name form (`cmd //c run-dev.bat`) fails from the repo root because
the bat lives in `flick/`, producing:
`'run-dev.bat' is not recognized as an internal or external command`.

The wrapper exists to source MSVC's `vcvarsall.bat x64` before `npm run tauri
dev`, so Rust's linker picks up MSVC's `link.exe` instead of Git-for-Windows's.

## TestBench: two extension variants

There are two TestBench VS Code extension source trees living side-by-side:

- `testbench-monaco/` — original variant, hosts the editor inside the webview
  using Monaco. Extension ID `pkent.testbench`.
- `testbench-native/` — newer variant, uses VS Code's native editor surface
  and adds the multi-test runner. Extension ID `pkent.testbench-native`.

Both source trees live on `main`. The extension IDs differ, so both VSIXes
can be installed side-by-side in the same VS Code profile.

## TestBench: bump the patch version on every change

Whenever you change code that ends up bundled into a TestBench VS Code
extension (anything under `testbench-monaco/` or `testbench-native/`, **and**
anything under `runner-core/` since that's a `file:` dep bundled into each
extension's `dist/`), bump the patch field in the affected variant's
`package.json` (e.g. `0.1.1` → `0.1.2`) as part of the same change.

The install/verify loop is then (substitute `testbench-monaco` or
`testbench-native` for `<variant>`):

```powershell
cd c:\Projects\vibe\ai-ui-automation\<variant>
npm run build
npm run package
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension testbench-<new-version>.vsix --force
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
gitignored files/dirs to actually run — `.env` (API keys), several
`node_modules/`, `flick/src-tauri/target/`, etc. Without them, nothing works
and `npm install` × 6 + a Tauri rebuild costs ~10 minutes.

Run this script once, right after the worktree is created:

```powershell
c:\Projects\vibe\ai-ui-automation\scripts\init-worktree.ps1 `
    -Destination <full-path-to-new-worktree>
```

It copies (not symlinks/junctions) env files and build dirs from the main
checkout at `c:\Projects\vibe\ai-ui-automation`, so the worktree is
independent and safe if `package.json` / `Cargo.toml` diverge.

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
