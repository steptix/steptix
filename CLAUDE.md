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

### Install from one checkout only

`~/.vscode/extensions/` is per-user, not per-window, so this loop is
machine-global — run it from exactly one checkout, normally the main one.
Installing from two (a worktree and main, or two worktrees) collides:

- **Same version in both** — the likely case, since two branches off one
  commit read the same version until someone bumps — and they extract into
  the *same* `pkent.testbench-native-<version>/` directory. Last writer wins,
  `--force` suppresses any prompt, and the Extensions panel shows that version
  either way: no signal about whose code is live. Genuinely concurrent
  installs are worse than last-write-wins, since two processes unzipping into
  one directory can leave a mix of both builds. Both also rewrite the shared
  `extensions.json`, so a race there can drop an entry.
- **Different versions** — both directories survive, but VS Code activates
  only the highest version of an extension ID, in *every* window. The worktree
  on the lower patch number then silently runs the other checkout's build
  while the Extensions panel truthfully reports the higher one.

Note the second case defeats the bump rule rather than being saved by it: the
version number is honest about what is loaded and still says nothing about
which checkout it came from.

To work on the extension in a worktree, don't install it — run an Extension
Development Host from that worktree instead:

```powershell
cd <worktree>\testbench-native
npm run build
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --extensionDevelopmentPath=.
```

The dev host loads from `--extensionDevelopmentPath` in place of the installed
copy, for that window only, so two worktrees can drive their own builds at the
same time without touching `~/.vscode/extensions/`.

`npm run dev` is the same two steps, but shells out to plain `code`. Unlike
`--install-extension`, the GUI exe does accept `--extensionDevelopmentPath` —
it is what VS Code's own generated launch configs pass via `${execPath}` — so
the script should work; it just hasn't been exercised in this repo, and the
shim above is the form already known to behave here.

The live integration tests were never affected: their harness passes its own
`--extensions-dir` under the worktree's `.vscode-test/`, so the installed
extension isn't on the path at all.

## Seed gitignored files into a new worktree

After creating a worktree (via `git worktree add` or the `EnterWorktree`
tool), the new directory only contains tracked files. The repo needs several
gitignored files/dirs to actually run — `.env` (API keys) and the five
`node_modules/` trees (root, `flick-vscode/`, `testbench-native/`,
`runner-core/`, and `fixtures/tools/`, without which every fixture tool's
`import 'ai-ui-automation/tools'` fails and 22 root tests go red). Without
them, nothing works and `npm install` × 5 costs several minutes.

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

They run in parallel, and they start everything they need. One command, from
any checkout:

```powershell
cd <worktree>\testbench-native
npm run test:live
```

That is four workers. Each gets its own VS Code instance, its own copy of
`templates/`, and its own server started from this checkout's `dist/` on a
free port from 3200 up. Workers pull the next test file off a shared queue as
they free up, so the split balances itself — file durations range from seconds
to minutes, and any assignment fixed before the run is a guess. Each file's
wall clock is remembered in `tests/integration/live-durations.json` and used
to start the slow ones first next time.

Because the runner starts those servers, it also builds what they run: it
shells `npm run build` at the repo root (~7 s) before picking ports. The
`test:live` script's own build covers `testbench-native` and `runner-core`
only, which was right while a human started the server and owned its
checkout. It is not right now, and the gap is silent — a worktree three days
stale ran the whole suite against a `dist/` predating the `@url` fallback in
`extractValueInPage`, so "Capture the current page URL" captured the empty
string, `{{first_url}}` stayed literal, and the failure looked like a model
that could not pick an action. Passing `--server=<url>` skips the build: that
server is yours, started from a checkout this runner should not compile.

```powershell
npm run test:live -- --shards=6        # a bigger box
npm run test:live -- --shards=1        # serial: one VS Code, one launch
npm run test:live -- --files=cache-replay.test.cjs,sections.test.cjs
$env:TESTBENCH_LIVE_GREP = "step cache replay"   # mocha --grep, as before
```

Measured on this machine (12 cores, 32 GB): 17 files, 1881 s of serial work,
421 s of wall clock at `--shards=4`. Four is not free, though — the shards
share one AI gateway key and one box, and what gives first is anything with a
timing budget: a breakpoint-pause wait, and (at the first attempt, with less
memory free) `ai.complete` returning empty after 86 s. If a
`*-breakpoint.test.cjs` flakes on a timeout, re-run it at `--shards=2` before
believing it.

Three things are per shard, and each one is load-bearing rather than tidy:

- **Workspace.** Five compile suites `rmSync` the *same*
  `templates/init/tests/.aiui-codebehind-cache`, two of them compile the same
  `compile-codebehind.md`, `cache-replay` wipes the project-wide
  `templates/init/.cache`, and `templates/.env` sets
  `APPEND_RUN_HISTORY_TO_TEST_FILE`, which rewrites the fixture `.md` a run
  just used. Grouping those conflicts onto one worker would put the five
  slowest suites back in a queue. So each worker copies `templates/` to
  `.live-shards/wN/templates` at the repo root (minus `reports/`, the caches
  and any stray `.steps.ts`) and the copy's `.env` gets `SERVER_URL` rewritten
  to that shard's port. That line, not any flag, is what decides which server
  the extension drives.

  A copy also breaks any config path that climbs out of the workspace, and
  `templates/init/aiui.config.json` has one: `"toolsDir":
  "../../fixtures/tools/src"`, which in a copy points at a `fixtures/` that was
  never copied. The server does not fail on that — it logs one `no tools
  registered` WARN and carries on — so the run dies minutes later in a
  different file's assertion. `rebaseConfigPaths` pins every out-of-tree
  relative path to its original absolute location (tool source is code the
  shards read, not state they write) and leaves in-tree ones relative so they
  travel. A `!` line in the runner's `config:` output means a key it does not
  know about climbs out too — the next `toolsDir`.

  **Where** the copy lives matters as much as what is in it, which is why it
  sits at the repo root rather than under `testbench-native/`. Node resolves a
  bare import by walking up from the file: from `<repo>/templates/...` that
  walk sees only `<repo>/node_modules`, but from
  `<repo>/testbench-native/.live-shards/...` it passes through
  `testbench-native/node_modules` first — a tree full of packages the real
  workspace cannot see. That is enough to make the esbuild bundle of a
  `.steps.ts` fail to load, and `loadCodeBehindFile` answers a load failure
  with a WARN and `Steps fall back to AI` — so every compile suite compiled,
  applied, and then failed its proving run with a plain ✓ where a `</>` was
  expected. Measured: `compile-tabs` passed serially and in a repo-root shard,
  and failed in a `testbench-native/` one.
- **VS Code.** A second VS Code sharing a `--user-data-dir` does not start a
  second instance — it forwards its arguments to the first one and exits, so
  every shard after the first would report nothing while the first silently
  ran someone else's files. Per-worker `--user-data-dir` and
  `--extensions-dir`, under the shard directory.
- **Server.** `addLogCallback` (src/utils/logger.ts) fans log lines out
  process-globally, so concurrent sessions in one server see each other's
  lines — and `compile-codebehind` asserts a line is *absent* from its run
  log. A process each makes the question not arise.

To drive a server you started yourself — for `--inspect`, or to watch one
failure against the `src/` you are editing — pass `--server=<url>`, which
`LIVE_SERVER_URL` still means too. Every shard then shares it, log cross-talk
included, which is why `--shards=1` is the usual companion:

```powershell
cd <worktree>
node dist/index.js serve -p <n> --idle-timeout 60
```

```powershell
cd <worktree>\testbench-native
npm run test:live -- --shards=1 --server=http://localhost:<n>
```

`--shards=1` is the runner this replaced, kept verbatim: one launch, every
file, the real `templates/` workspace, VS Code's output inherited so you can
watch it. It is also the one mode that still has *two* independent notions of
where the server is — the extension reads `SERVER_URL` by walking up from the
test file to `templates/.env`, while the assertions read `LIVE_SERVER_URL` and
fall back to `:3100` regardless. Set only one and the tests assert against a
different server than the extension is driving. The parallel path writes both
from the same value, so it cannot drift.

`serve` needs no `--env-file`: `%LOCALAPPDATA%\aiui\.env` carries
`AIUI_SERVER_API_KEY`, `AI_API_KEY` and `AI_MODEL` machine-wide, and its key
matches the one in `.env` and `templates/.env`.

The rest is already handled: `runLiveTest.cjs` boots the `fixtures/test-app`
site the browser-driving suites point at — one app for every shard, since the
pages are static markup — and Playwright's browsers live in
`%LOCALAPPDATA%\ms-playwright`, machine-wide, so no worktree re-downloads
them.

### Running live suites in two worktrees at once

Seven of the nine live suites are safe to run concurrently. Everything they
contend on is per-worktree:

- **Servers** — distinct ports, via `-AutoPort`.
- **VS Code** — each run gets its own `--user-data-dir` and `--extensions-dir`
  under that worktree's `.vscode-test/`, so the instances don't forward to
  each other. (Same mechanism as the orphaned-`Code.exe` hijack, working in
  your favour: that bug needs a *shared* user-data-dir.)
- **Extension code** — `--extensionDevelopmentPath` per worktree, so the
  installed `.vsix` is not on the path in either run.
- **CDP browsers** — profiles resolve to
  `<project_root>/.aiui/cdp-profiles/<engine>-<name>/`
  (`profileDirFor`, src/browser/cdp-registry.ts) and the launcher passes
  `--remote-debugging-port=0`, so the OS assigns the port and it is read back
  from `DevToolsActivePort`. Concurrency-safe by construction.
- **Playwright** — shared binaries, per-launch temp profiles.
- **`reports/` and `.cache/`** — resolved against the project root.

- **The fixture app** — `fixtures/test-app` on the pinned port 8787, booted
  by `runLiveTest.cjs`. First run in wins the port; later runs probe it,
  adopt it, and leave it alone on exit. Safe to share for the pages, which
  are static markup. Since PR #117 it does hold one piece of per-run state:
  the `/api/documents` list behind the Documents page. Tests that assert
  on it clear it first (`DELETE /api/documents`), but two runs uploading
  at the same moment can still see each other's rows — a
  `securebank-upload.md` row-count failure during a concurrent run is that,
  not a regression.

There used to be an exception here: `templates/init/tests/github.md` drove a
real github.com login, so two worktrees ran it with the same credentials from
the same IP, and one run's sign-out could invalidate the other's session
mid-test. That is gone — `pause-resume` and `stop-report` now drive
`templates/init/tests/securebank.md` against the fixture app instead. Same
shape of flow (navigate, sign in, read a list, sign out), no external account,
no rate limit, no 2FA challenge. `github.md` itself stays on disk: the fast
suite opens it as a parse fixture, and it remains a worked example of testing
a real site.

The AI gateway key is still shared. Not a correctness problem, but concurrent
runs share whatever rate limit it carries, so a flake there is not
automatically a regression.

Traced by reading, not yet proven by running two full suites at once.

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

`fixtures/tools/node_modules/ai-ui-automation` is the second such junction
(the `file:../..` dep), but its target is the whole repo root — following it
during a copy would recurse the entire checkout into itself — so the script
excludes it from the robocopy outright and creates it fresh, pointed at the
worktree.

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
