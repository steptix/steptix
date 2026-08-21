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
    -Destination <full-path-to-new-worktree> -AutoPort
```

It copies (not symlinks/junctions) env files and build dirs from the main
checkout at `c:\Projects\vibe\ai-ui-automation`, so the worktree is
independent and safe if `package.json` diverges between branches. It then
re-points the runner-core junction, builds `dist/` in all three projects, and
rewrites `SERVER_URL` in the worktree's `.env` files to the port it allocated.

`-AutoPort` takes the lowest free port from 3101 up, treating a port any other
registered worktree was seeded with as taken even when nothing is listening on
it — a stopped server still owns its port. Re-running on an already-ported
worktree keeps the port it had. Use `-Port <n>` instead to pick by hand; the
two are mutually exclusive.

Other switches: `-SkipBuilds` copies only the env files (docs-only changes);
`-Install` runs `npm install` when the branch changed dependencies;
`-SeedVSCodeTest` copies the cached VS Code build (~390 MB) so the first
`npm run test:integration` doesn't re-download it.

To recall a worktree's port later, read it back off the file that decides it:
`grep SERVER_URL .env`.

### Which server does the worktree talk to?

`aiui.config.json` pins port 3100 and is tracked, so two checkouts can't both
serve on the default; the second dies on EADDRINUSE. You only need a second
server when you changed `src/` — a running server resolves each request's
project bundle from the test file's path
([src/server/project-bundle.ts](src/server/project-bundle.ts)), so it already
honours a worktree's own `aiui.config.json` and `.env`, but it executes
whatever `src/` build it booted from. `-AutoPort` (or `-Port <n>`) plus
`node dist/index.js serve -p <n>` gives the worktree its own.

TestBench won't auto-start that server for you:
`testbench-native.serverAutoStart.cwd` is machine-scoped (User settings only,
by design — a workspace-settable value would let any cloned repo run arbitrary
code on Run), so a worktree window auto-starts the server from whichever
checkout that setting names. Start the worktree's server yourself. On a
non-default port that's not optional: the auto-start command carries no `-p`,
so it would start the *other* checkout's server on 3100, keep polling your
port, and fail with TB028 — leaving a stray server behind.

### Live integration tests in a worktree

They work. Two manual commands, because the run has *two* independent notions
of where the server is and both have to point at this worktree's:

```powershell
# 1. this worktree's server, on its own port — leave it running
cd <worktree>
node dist/index.js serve -p <n> --idle-timeout 60
```

```powershell
# 2. the live suite, told to assert against that same server
cd <worktree>\testbench-native
$env:LIVE_SERVER_URL = "http://localhost:<n>"
$env:TESTBENCH_LIVE_GREP = "step cache replay"   # optional; full suite is >10 min
npm run test:live
```

The extension reads `SERVER_URL` by walking up from the test file to
`templates/.env` (seeded and port-rewritten by the script). The test
assertions read `LIVE_SERVER_URL`, which falls back to `:3100` in every
suite regardless. Set only one and the tests assert against a different
server than the extension is driving.

`serve` needs no `--env-file`: `%LOCALAPPDATA%\aiui\.env` carries
`AIUI_SERVER_API_KEY`, `AI_API_KEY` and `AI_MODEL` machine-wide, and its key
matches the one in `.env` and `templates/.env`.

Without `-Port` there is no env var to set — but then nothing else may be
listening on 3100, or the suite silently tests the *other* checkout's `src/`.
That silence is why `-Port` is the better default for a worktree.

The rest is already handled: `templates/.env` is both the live workspace and
the source of `GITHUB_USERNAME`/`GITHUB_PASSWORD`, and Playwright's browsers
live in `%LOCALAPPDATA%\ms-playwright`, machine-wide, so no worktree
re-downloads them.

### Why the junction repair matters

`testbench-native/node_modules/ai-ui-automation-runner-core` is the
`file:../runner-core` dep, which npm materialises as a junction holding an
**absolute** path to whichever checkout ran `npm install`. robocopy follows it
and writes a real directory, so a naively-seeded worktree holds a frozen copy
of main's runner-core. `npm run build` then reports success while esbuild
bundles the stale code — it resolves through `node_modules`, whereas
`build:runner-core` compiles `../runner-core`, a different place. The script
re-points the junction after copying; `npm install` in `testbench-native/`
also fixes it.

### Why `dist/` has to be built in the worktree

The package self-import `ai-ui-automation/tools` (used
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
