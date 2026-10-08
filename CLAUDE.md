# Project notes

## The name is Steptix

This product was called AI UI Automation (package `ai-ui-automation`, CLI
`aiui`) and its VS Code extension TestBench (`testbench-native/`,
`pkent.testbench-native`, error codes `TBxxx`). Both are Steptix now — see the
top CHANGELOG entry for the full map. Resolved issues and older CHANGELOG
entries keep the old names on purpose; read `aiui` there as `steptix` and
`TB028` as `STX028`.

The server address variable `SERVER_URL` became `STEPTIX_SERVER_URL` the same
way, with no fallback, and the live tests' `LIVE_SERVER_URL` became
`LIVE_STEPTIX_SERVER_URL`. Resolved issues keep the old names.

The checkout folder was renamed from `ai-ui-automation` to `steptix` as well.
Anything that stored the old absolute path went stale with the rename rather
than failing loudly — notably the two `node_modules` junctions in the main
checkout, see [Why the junction repair matters](#why-the-junction-repair-matters).
So commands here don't hardcode where the checkout lives: they write it as
`<main-checkout>`, and git can tell you from inside any worktree:

```powershell
(git worktree list --porcelain)[0] -replace '^worktree ', ''
```

The GitHub repo is `steptix/steptix`. Links to `pkent/steptix` and
`pkent/ai-ui-automation` in resolved issues, stories and older CHANGELOG
entries, and `pkent/steptix-archive#N` in commit messages, lead to the
private archive of the repo before the move, which only maintainers can
open. Leave them as written.

## Flick: one client

`flick-vscode/` is the Flick client — a chat panel inside VS Code for driving
the Sessions API with natural-language steps. Extension ID `pkent.flick-vscode`.

There used to be a second client, `flick/`, a standalone Tauri desktop app
(Svelte front end, Rust backend) built to [SPEC-FLICK.md](docs/specs/SPEC-FLICK.md). It was
removed in favour of the VS Code extension — see
[issue 049](issues/resolved/049-remove-flick-tauri.md). With it went the only
reason this repo needed a Rust/MSVC toolchain.

`SPEC-FLICK.md` stays: it is still the behavioural spec flick-vscode follows,
with a note marking which sections described the removed desktop shell.

## Steptix: one extension

`steptix-vscode/` is the Steptix VS Code extension — it uses VS Code's
native editor surface and hosts the multi-test runner. Extension ID
`pkent.steptix-vscode`.

There used to be a second variant, `testbench-monaco/` (extension ID
`pkent.testbench`), which hosted the editor inside a webview using Monaco.
It was removed in favour of the native variant — see
[issue 048](issues/resolved/048-remove-testbench-monaco.md).
If you still have `pkent.testbench` installed, uninstall it; it is no longer
built from this repo.

## Steptix: bump the patch version on every change

Whenever you change code that ends up bundled into the Steptix VS Code
extension (anything under `steptix-vscode/`, **and** anything under
`runner-core/` since that's a `file:` dep bundled into the extension's
`dist/`), bump the patch field in `steptix-vscode/package.json`
(e.g. `0.1.1` → `0.1.2`) as part of the same change.

The install/verify loop is then:

```powershell
cd <main-checkout>\steptix-vscode
npm run build
npm run package
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension steptix-vscode-<new-version>.vsix --force
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
  the *same* `pkent.steptix-vscode-<version>/` directory. Last writer wins,
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
cd <worktree>\steptix-vscode
npm run build
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --extensionDevelopmentPath="$PWD" <folder-to-open>
```

**The path must be absolute.** Measured 2026-09-23: with VS Code already
running, `--extensionDevelopmentPath=.` opened a window titled
`[Extension Development Host]` that scanned the root of the C: drive for the
extension (its renderer.log fills with `Unable to read file
'\$Recycle.Bin\package.json'` from `scanExtensionsUnderDevelopment`) and then
quietly ran the INSTALLED copy — Running Extensions showed 0.5.143 where the
worktree was 0.5.145. The folder argument beside it resolved correctly; only
the development path did not. `"$PWD"` expands to the absolute path before the
shim sees it. Check Running Extensions for the worktree's version before
trusting the window.

The dev host loads from `--extensionDevelopmentPath` in place of the installed
copy, for that window only, so two worktrees can drive their own builds at the
same time without touching `~/.vscode/extensions/`.

One thing it does NOT isolate: the Copilot bridge's port. Its setting is
machine-scoped and one window per machine owns `127.0.0.1:18790`; the others
stand by and claim it when the owner closes. So with ordinary windows open on
the installed Steptix and `lmBridge.enabled` on, a dev host's bridge never
serves — requests reach the installed copy's bridge instead. To exercise a
worktree's bridge, close every other VS Code window first (and run anything
that must survive that, such as the server, from a terminal outside VS Code).
`GET /v1/models` on the port tells them apart once the bridge carries
`steptix_bridge` (tb 0.5.145+).

`npm run dev` is the same two steps, but shells out to plain `code`. Unlike
`--install-extension`, the GUI exe does accept `--extensionDevelopmentPath` —
it is what VS Code's own generated launch configs pass via `${execPath}` — so
the script should work; it just hasn't been exercised in this repo, and the
shim above is the form already known to behave here.

The live integration tests were never affected: their harness passes its own
`--extensions-dir` under the worktree's `.vscode-test/`, so the installed
extension isn't on the path at all.

## Runtime installer: every build is tested end to end

Build the Windows runtime installer only with `node scripts/build-runtime.mjs`.
It runs `scripts/verify-runtime.mjs` on every installer it compiles: install,
the CLI through `steptix.cmd`, a VS Code Run that auto-starts the installed
server through `steptix.cmd`, refusals while that server runs, `steptix` on
PATH, an upgrade to a newer version that removes it and a rollback, and
uninstall through the Installed Apps entry.
The installer only moves into `dist-runtime/` if all of that passes. Never
compile `packaging/runtime/runtime.nsi` by hand, never add a way to skip the
test, and never ship anything from `dist-runtime/unverified/`. See
[packaging/runtime/README.md](packaging/runtime/README.md).

## Unit tests pass on Windows, Linux and macOS

The four unit suites must pass on all three: root `npm test`, and `npm test` in
`runner-core/`, `flick-vscode/` and `steptix-vscode/`. Product behaviour must
be on par too: what works on one platform needs a counterpart on the others,
not a platform-specific gap that a test works around.

- **Build fixture paths that are native to the platform.** Use
  `path.resolve(path.sep, 'proj')`, `os.tmpdir()`, or `path.join` from such a
  root. Never hard-code `C:\…` or `path.join('C:', …)`: on Linux and macOS
  that is a relative name, which `path.isAbsolute` rejects and
  `pathToFileURL` resolves against the working directory.
- **Mark a test that is about one platform.** Use
  `it.runIf(process.platform === 'win32')` (or `path.sep === '/'` for Linux
  and macOS together), or `path.win32` / `path.posix` explicitly. Give the
  other platforms their own case where the behaviour differs, as
  `tests/upload-paths.test.ts` does for rooted paths.
- **Keep `npm test` building first** (`pretest`). Several suites run `dist/`
  on purpose, and a stale one tests old code without any warning. Plain
  `npx vitest` skips `pretest`, so build first if you use it.
- **Treat macOS as POSIX but not Linux.** Its default filesystem is
  case-insensitive, so a test must not depend on case either way.
  `os.tmpdir()` is under `/var/folders/…`, a symlink to `/private/var/…`, so
  compare `fs.realpathSync` forms when a path is read back through
  `realpath` or `process.cwd()`.

To check on Linux from this machine, use WSL Ubuntu. Node 24 is in
`~/.local/node/bin` there (not on the default PATH), and `~/steptix-linux` is
a test clone of the Windows checkout with its own Linux `node_modules`:

```bash
wsl.exe -e bash -lc 'export PATH=$HOME/.local/node/bin:$PATH; cd ~/steptix-linux && git fetch -q && git checkout -f origin/<branch> && npm test'
```

Its `origin` is the Windows checkout, so to test an uncommitted change, run
`git diff HEAD > patch` there and `git apply` in the clone. Run `npm ci` in
each of the five projects if the branch changed dependencies. WSL has no
Playwright browser, so ignore the root suite's real-browser tests there (they
fail with `browserType.launch: Executable doesn't exist`) and judge Linux on
everything else.

## Unit tests are not timed and share nothing

A unit test must give the same answer on a loaded CI runner, in any order,
and on any developer's machine.

- **Never wait with a sleep or assert on elapsed time.** Wait on the condition
  itself — an event, a promise gate, or a poll with a generous ceiling. When
  the code under test is timed, inject `now`/`sleep` or use
  `vi.useFakeTimers({ toFake: [...] })`.
- **Let the server pick its port.** Have the child bind port 0 and report the
  port it got; `tests/fixture-server.ts` does this for the SecureBank app.
  Never close a port-0 listener and hand its number on.
- **Bind with `listenFetchable(server, host)`** from `tests/listen-fetchable.cjs`
  (every package can load it), not a bare `listen(0)`. It draws again when the
  OS hands out a port `fetch` and Chromium refuse ("bad port"). The one
  exception to the rule above is its `freeFetchablePort()`, for a process that
  cannot bind 0 and report back (a port setting, a CLI flag); it races, so
  never use it for a server in the test's own process. `npm run lint` and CI
  run `scripts/check-listen-fetchable.mjs`, which fails on a bare one.
- **Give each run its own scratch directory** with `fs.mkdtemp`. Put it under
  `tests/` when package self-resolution needs an in-repo path. Remove it
  recursively with `maxRetries`.
- **Leave nothing behind.** Restore every global you change (`process.env`,
  `process.stdout.isTTY`, page globals) in `finally` or `afterEach`. Clear
  module-level mocks in `beforeEach`. Give a test that changes a shared page
  its own page. The weekly `Unit tests (shuffled)` workflow runs the root
  suite in a random order to catch what slips through.
- **Don't read the developer's machine.**
  - Point `LOCALAPPDATA` / `XDG_CONFIG_HOME` at a temp dir before anything
    resolves the user root.
  - Pass `loadConfig` an explicit project root.
  - Don't depend on the locale or on a fixed calendar year.

## No real secrets in tracked files

Treat every commit as public, history included: deleting a line later does
not unpublish it. Keep every real credential — `STEPTIX_SERVER_API_KEY`, `AI_API_KEY`, gateway
and provider keys, GitHub, npm and Marketplace tokens, passwords — out of
tracked files: code, tests, scripts, docs, issues, stories and fixtures.

- **Read keys from where they live.** The server key is the machine key in
  `%LOCALAPPDATA%\steptix\.env` (`~/.steptix/.env` elsewhere); AI keys come
  from a gitignored `.env` or the environment. A script that talks to a
  server reads `process.env.STEPTIX_SERVER_API_KEY`, else `readMachineKey()`
  or `ensureMachineKey()` from `src/env/user-root.ts` — the same chain
  `serve` uses, so the two always agree.
- **Use fakes that say what they are in tests.** Name the key after the test
  (`'compile-api-key'`, `'integration-test-key'`), never a random-looking
  string, so neither a reader nor a scanner mistakes it for a real one.
- **Paste nothing real into docs.** Redact keys, tokens and `Authorization`
  headers from logs, stack traces and request dumps before they go into an
  issue, story or report.
- **Keep `.env` files untracked.** Add new variables to `.env.example` with an
  empty value.
- **Rotate a key that was ever committed.** Deleting it from the file or from
  history does not unpublish it; rotating does. For the server key, remove
  its line from the machine `.env` and restart `serve`, which writes a new
  one; then update every client that holds a copy, such as `flick.apiKey`.

When reviewing a diff, `/code-review` included, report as a blocking finding
any string literal that looks like a real credential: one assigned to a
`*KEY*`, `*TOKEN*`, `*SECRET*` or `*PASSWORD*` name, sent as `x-api-key` or
`Authorization`, or shaped like a known key (`steptix_` + hex, a bare UUID,
`sk-`, `ghp_`, `github_pat_`, `npm_`, `AKIA`, a PEM block). Also report a
tracked `.env`, and a real value added to `.env.example`. A fake that names
its own test is not a finding.

## No site-specific code in the framework

Steptix has to work on any website or web application, so the framework never
knows about a particular one. Everything a test needs to know about its site
lives in that test's `.md` file.

- **Keep selectors out of the framework.** Never hardcode a selector, id,
  class name, URL or piece of page text taken from a site or app under test —
  the survey sites, `fixtures/test-app` (SecureBank) or any other — in `src/`,
  `runner-core/` or the extensions: not in code, not in defaults, and not in AI
  prompts. Selectors and page text for a site go in that site's test `.md`.
- **Write prompt examples with invented names.** An example teaches a pattern,
  so give it names no tested page uses (`#item`, `#host`, `#grid_row_7`, "Ada",
  "Order 12 was placed."). An example copied from a test site hands the model
  that site's answer and makes the site's results look better than the
  framework is.
- **Fix the pattern, not the site.** When one site exposes a gap, make the fix
  react to what the page does (a hidden checkbox input, a drag that needs
  intermediate moves, a frame) and check it would behave the same on any page
  that does it.
- **Don't route around one site with a switch.** A browser launch flag or a
  config setting that makes one site work (`--disable-http2`, a longer global
  timeout) is a workaround, not a fix. Find the cause; until then, record the
  site as failing and why.
- **Generic web standards are fine.** HTML element names, input types and ARIA
  roles and attributes (`select`, `input[type=file]`, `[role="dialog"]`,
  `aria-live`) describe every page, not one.

When reviewing a diff, `/code-review` included, report as a blocking finding
any selector, id, class name, URL or page text under `src/`, `runner-core/` or
the extensions that appears on a site or app the tests drive. A name that
appears only in a comment saying where a problem was found is not a finding.

## Seed gitignored files into a new worktree

After creating a worktree (via `git worktree add` or the `EnterWorktree`
tool), the new directory only contains tracked files. The repo needs several
gitignored files/dirs to actually run — `.env` (API keys) and the five
`node_modules/` trees (root, `flick-vscode/`, `steptix-vscode/`,
`runner-core/`, and `fixtures/tools/`, without which every fixture tool's
`import 'steptix/tools'` fails and 22 root tests go red). Without
them, nothing works and `npm install` × 5 costs several minutes.

Run this script once, right after the worktree is created:

```powershell
<main-checkout>\scripts\init-worktree.ps1 `
    -Destination <full-path-to-new-worktree> -AutoPort
```

It copies (not symlinks/junctions) env files and build dirs from the checkout
the script itself sits in — which is why it's the main checkout's copy you
run, not the new worktree's — so the worktree is
independent and safe if `package.json` diverges between branches. It then
re-points the runner-core junction, builds `dist/` in all three projects, and
rewrites `STEPTIX_SERVER_URL` in the worktree's `.env` files to the port it allocated.

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
`grep STEPTIX_SERVER_URL .env`.

### Which server does the worktree talk to?

A bare `serve` listens on the port of `STEPTIX_SERVER_URL` in
`%LOCALAPPDATA%\steptix\.env`, else 3100 — never on a port a project's `.env`
names — so two checkouts can't both serve bare; the second exits naming the
taken port. You only need a second
server when you changed `src/` — a running server resolves each request's
project bundle from the test file's path
([src/server/project-bundle.ts](src/server/project-bundle.ts)), so it already
honours a worktree's own `steptix.config.json` and `.env`, but it executes
whatever `src/` build it booted from. `-AutoPort` (or `-Port <n>`) plus
`node dist/index.js serve -p <n>` gives the worktree its own.

Steptix won't auto-start that server for you:
`steptix.serverAutoStart.cwd` is machine-scoped (User settings only,
by design — a workspace-settable value would let any cloned repo run arbitrary
code on Run), so a worktree window auto-starts the server from whichever
checkout that setting names. Start the worktree's server yourself. On a
non-default port that's not optional: the auto-start command carries no `-p`,
so it would listen on 3100, not your port — Steptix sees that and refuses to
start it (STX033) instead.

### Live integration tests in a worktree

They run in parallel, and they start everything they need. One command, from
any checkout:

```powershell
cd <worktree>\steptix-vscode
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
`test:live` script's own build covers `steptix-vscode` and `runner-core`
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
npm run test:live -- --files=data-rows.test.cjs,sections.test.cjs
$env:STEPTIX_LIVE_GREP = "inline sections"   # mocha --grep, as before
```

Measured on this machine (12 cores, 32 GB): 17 files, 1881 s of serial work,
421 s of wall clock at `--shards=4`. Four is not free, though — the shards
share one AI gateway key and one box, and what gives first is anything with a
timing budget: a breakpoint-pause wait, and (at the first attempt, with less
memory free) `ai.complete` returning empty after 86 s. If a
`*-breakpoint.test.cjs` flakes on a timeout, re-run it at `--shards=2` before
believing it.

Shards also cost coverage in one specific place, and the runner counts it out
loud rather than hiding it. The two `cdp-tab-focus` screenshot checks skip
themselves when Chromium produces no frames for a window the compositor
considers occluded — the documented limitation in
stories/cdp-tab-focus.md §Risks. Only one window can be in front, so four
shards means at least three are occluded and the skip gets likelier: serially
one of the two skipped, at `--shards=4` both did. A skip is a scenario nobody
checked, so if you are actually changing tab focus or capture, run that file
on its own with the window visible.

Three things are per shard, and each one is load-bearing rather than tidy:

- **Workspace.** Five compile suites `rmSync` the *same*
  `templates/init/tests/.steptix-codebehind-cache`, two of them compile the same
  `compile-codebehind.md`, and `templates/.env` sets
  `APPEND_RUN_HISTORY_TO_TEST_FILE`, which rewrites the fixture `.md` a run
  just used. Grouping those conflicts onto one worker would put the five
  slowest suites back in a queue. So each worker copies `templates/` to
  `.live-shards/wN/templates` at the repo root (minus `reports/`, the caches
  and any stray `.steps.ts`) and the copy's `.env` gets `STEPTIX_SERVER_URL` rewritten
  to that shard's port. That line, not any flag, is what decides which server
  the extension drives.

  A copy also breaks any config path that climbs out of the workspace, and
  `templates/init/steptix.config.json` has one: `"toolsDir":
  "../../fixtures/tools/src"`, which in a copy points at a `fixtures/` that was
  never copied. The server does not fail on that — it logs one `no tools
  registered` WARN and carries on — so the run dies minutes later in a
  different file's assertion. `rebaseConfigPaths` pins every out-of-tree
  relative path to its original absolute location (tool source is code the
  shards read, not state they write) and leaves in-tree ones relative so they
  travel. A `!` line in the runner's `config:` output means a key it does not
  know about climbs out too — the next `toolsDir`.

  **Where** the copy lives matters as much as what is in it, which is why it
  sits at the repo root rather than under `steptix-vscode/`. Node resolves a
  bare import by walking up from the file: from `<repo>/templates/...` that
  walk sees only `<repo>/node_modules`, but from
  `<repo>/steptix-vscode/.live-shards/...` it passes through
  `steptix-vscode/node_modules` first — a tree full of packages the real
  workspace cannot see. That is enough to make the esbuild bundle of a
  `.steps.ts` fail to load, and `loadCodeBehindFile` answers a load failure
  with a WARN and `Steps fall back to AI` — so every compile suite compiled,
  applied, and then failed its proving run with a plain ✓ where a `</>` was
  expected. Measured: `compile-tabs` passed serially and in a repo-root shard,
  and failed in a `steptix-vscode/` one.
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
`LIVE_STEPTIX_SERVER_URL` still means too. Every shard then shares it, log cross-talk
included, which is why `--shards=1` is the usual companion:

```powershell
cd <worktree>
$env:STEPTIX_STATS_SUITE = 'live'
node dist/index.js serve -p <n> --idle-timeout 60
```

`STEPTIX_STATS_SUITE=live` tags every line that server writes to the first-try
scoreboard (docs/specs/SPEC-scoreboard.md), so test runs stay out of
`steptix stats`'s default view. The parallel runner sets it on the servers it
starts; a server you start yourself records as `user` unless you set it.

```powershell
cd <worktree>\steptix-vscode
npm run test:live -- --shards=1 --server=http://localhost:<n>
```

`--shards=1` is the runner this replaced, kept verbatim: one launch, every
file, the real `templates/` workspace, VS Code's output inherited so you can
watch it. Verbatim includes its prerequisite — it starts no server and builds
no `dist/`, so one must already be running (`:3100` unless you say otherwise)
and be current. That is the whole difference in ownership: the parallel path
starts the servers so it builds them, this one does not so it does not.

It is also the one mode that still has *two* independent notions of
where the server is — the extension reads `STEPTIX_SERVER_URL` by walking up from the
test file to `templates/.env`, while the assertions read `LIVE_STEPTIX_SERVER_URL` and
fall back to `:3100` regardless. Set only one and the tests assert against a
different server than the extension is driving. The parallel path writes both
from the same value, so it cannot drift.

`serve` needs no `--env-file`: it reads `STEPTIX_SERVER_API_KEY` from
`%LOCALAPPDATA%\steptix\.env`, the one key on the machine, and generates it
there if it is missing. `.env` and `templates/.env` carry no key of their own,
so every client finds the same one. They do set `AI_API_KEY` and `AI_MODEL`,
which a request sends with it; `%LOCALAPPDATA%\steptix\.env` would only
supply those as a fallback for a project that sets neither.

The rest is already handled: `runLiveTest.cjs` boots the `fixtures/test-app`
site the browser-driving suites point at — one app for every shard, since the
pages are static markup — and Playwright's browsers live in
`%LOCALAPPDATA%\ms-playwright`, machine-wide, so no worktree re-downloads
them.

### Running live suites in two worktrees at once

Read the sharding section above first — a single run is *already* four VS
Code instances, four servers and four browsers, so two worktrees at once
means eight of each. That, not correctness, is the reason to think twice: on
a 12-core box the four-shard run already loses a `cdp-tab-focus` capture
check to occlusion and once lost a breakpoint wait to a timing budget.
Doubling it makes those likelier, and neither failure names its cause.

What they contend on is safe, and mostly by construction rather than by
arrangement:

- **Servers** — the runner scans upward from 3200 and skips any port already
  listening, so a second worktree lands on the next free ones without being
  told. The window where both scan before either binds is narrow, and loses
  loudly: `serve` exits on EADDRINUSE and `startServer` reports *"exited
  before becoming ready"* with the log path. It does not fall through to a
  server someone else owns.
- **Stale-server reaping** — each worktree records its own pids in its own
  `tests/integration/live-servers.json`, and only kills a pid when `/health`
  on that port answers claiming to *be* that pid. It cannot reap the other
  worktree's servers, and pid reuse cannot make it kill a stranger.
- **VS Code** — `--user-data-dir` and `--extensions-dir` are per SHARD now,
  under `<repo>/.live-shards/wN/`, so they are per worktree for free.
  (Same mechanism as the orphaned-`Code.exe` hijack, working in your favour:
  that bug needs a *shared* user-data-dir.)
- **Extension code** — `--extensionDevelopmentPath` per worktree, so the
  installed `.vsix` is not on the path in either run.
- **Workspaces** — each shard drives its own copy of `templates/` under its
  own worktree's `.live-shards/`, so the fixture files, the caches and the
  `reports/` two runs would otherwise share are already separated.
- **CDP browsers** — profiles resolve to
  `<project_root>/.steptix/cdp-profiles/<engine>-<name>/`
  (`profileDirFor`, src/browser/cdp-registry.ts), and the project root is now
  the shard's own copied workspace, so profiles are per shard. The launcher
  passes `--remote-debugging-port=0`, so the OS assigns the port and it is
  read back from `DevToolsActivePort`.
- **Playwright** — shared binaries, per-launch temp profiles.

- **The fixture app** — `fixtures/test-app` on the pinned port 8787, booted
  by `runLiveTest.cjs`. First run in wins the port; later runs probe it,
  adopt it, and leave it alone on exit — which is what lets eight shards
  share one. Safe for the pages, which are static markup. Since PR #117 it
  does hold one piece of per-run state: the `/api/documents` list behind the
  Documents page. Tests that assert on it clear it first
  (`DELETE /api/documents`), but two runs uploading at the same moment can
  still see each other's rows, and one run's "Clear all" wipes the other's rows
  mid-loop. `data-rows.test.cjs` drives it (`securebank-upload-rows.md`: three
  uploads, then a count of 3), so a count of 5, 4 or 2 during a concurrent run
  is that, not a regression. The report says which: the fixture server's
  `doc-NNN` ids never reset across `DELETE`, so a table whose ids do not start
  at `doc-001` had another run's uploads in it. Before a gate run, check who
  owns 8787 (`Get-NetTCPConnection -LocalPort 8787 -State Listen`) and whether
  a `Code.exe` under another worktree's `.vscode-test` is alive — measured
  2026-09-11: a gate failed twice on exactly this while another session's
  live run was adopting the app.

Tests under `templates/init/tests/` drive only applications this repo
controls: the `fixtures/test-app` site (SecureBank) or the local desktop. Do
not add tests against third-party sites. Two runs would share one external
account and IP, so one run's sign-out can invalidate the other's session, and
rate limits and 2FA challenges fail runs for reasons unrelated to the code
under test.

The AI gateway key is still shared, and now by eight shards rather than two
runs. Not a correctness problem, but they share whatever rate limit it
carries — a four-shard run has already produced `ai.complete` returning
empty after 86 s — so a flake there is not automatically a regression.

Traced by reading, not proven by running two full suites at once. Within one
worktree, four shards and two shards have both come back clean.

### Computer-mode live test

`computer-use.test.cjs` drives `templates/init/tests/pdf-dialog-cancel.md`,
which leaves the browser at `[use computer]` and clicks a PDF toolbar and a
print dialog with the **real mouse**
([SPEC-use-computer.md](docs/specs/SPEC-use-computer.md) §13.3). It skips
itself unless `STEPTIX_LIVE_COMPUTER=1` is set, and the reason is the
sharding section above: a default run is four shards on one box, and there is
one pointer. Two shards moving it do not produce two flaky runs — they produce
one run clicking where the other run's dialog used to be. The framework's lock
(spec §5.9) refuses the second computer-mode session outright, which would
turn the whole parallel suite red for a reason unrelated to the code under
test. So the gate is in the suite, not in the runner: the file is discovered
and scheduled like any other, costs a few seconds, and reports as a `pending`
row (an `o`) rather than vanishing.

Run it alone, one shard, against a server you started (tagged `live` for the
scoreboard, as above):

```powershell
cd <worktree>
$env:STEPTIX_STATS_SUITE = 'live'
node dist/index.js serve -p <n> --idle-timeout 60
```

```powershell
cd <worktree>\steptix-vscode
$env:STEPTIX_LIVE_COMPUTER = '1'
npm run test:live -- --shards=1 --files=computer-use.test.cjs --server=http://localhost:<n>
```

`--server=<url>` is not optional here even though `--shards=1` defaults to
`:3100`: the serial path is the one mode with two independent notions of where
the server is (see above), so pass the same URL that this worktree's
`templates/.env` carries as `STEPTIX_SERVER_URL`.

**Start that server from a normal terminal or from VS Code**, not from a
sandboxed tool runner. Measured 2026-09-23: a process started by the Claude
desktop app's tool runner can enumerate windows and get a screen DC but cannot
blit from it — `screen.grab()` fails with BitBlt error 6, in and out of that
tool's own sandbox flag, and a .NET `CopyFromScreen` fails identically from the
same context. The server then boots fine and every computer-mode step is
blind; the spec's §5.1 capture probe turns that into a named failure at
`[use computer]` instead of a model that cannot find a button.

While it runs: a visible, unlocked desktop, and nobody touching the mouse or
the keyboard. A disconnected RDP session captures black. A stray click moves
focus and the next screenshot is no longer of what the model was answering
about. The test says so in its own header too, because the person who starts
it is not always the person who wrote it.

`computer-calc.test.cjs` sits beside it behind the same gate and runs the same
way, with `--files=computer-calc.test.cjs`. It drives `calc-one-plus-one.md` —
desktop only, no browser at all — twice in one Steptix session: once with a
breakpoint on step 5, reading `steptix-computer.lock` itself while the run is
parked to show the server gave the lock back, then Continue to 9/9; then a
second Run All in the kept session. Every phase also watches the file while it
runs and requires seeing the server's pid in it, so "not held" cannot pass by
reading the wrong temp directory. Step 2 is `[tool: open_calculator]`, so the
fixture tools must load (`fixtures/tools/node_modules`, a built `dist/`). A run
that fails partway can leave Calculator open; close it before the next attempt.

### Why the junction repair matters

`steptix-vscode/node_modules/steptix-runner-core` is the
`file:../runner-core` dep, which npm materialises as a junction holding an
**absolute** path to whichever checkout ran `npm install`. robocopy follows it
and writes a real directory, so a naively-seeded worktree holds a frozen copy
of main's runner-core. `npm run build` then reports success while esbuild
bundles the stale code — it resolves through `node_modules`, whereas
`build:runner-core` compiles `../runner-core`, a different place. The script
re-points the junction after copying; `npm install` in `steptix-vscode/`
also fixes it.

`fixtures/tools/node_modules/steptix` is the second such junction
(the `file:../..` dep), but its target is the whole repo root — following it
during a copy would recurse the entire checkout into itself — so the script
excludes it from the robocopy outright and creates it fresh, pointed at the
worktree.

The script repairs the *worktree's* junctions, not the source's. Because they
hold absolute paths, moving or renaming the main checkout leaves its own two
junctions dangling, and seeding then dies copying `steptix-vscode/node_modules/`
with `robocopy failed ... (exit 8)` or `(exit 9)`. Measured 2026-09-30, after
the `ai-ui-automation` → `steptix` folder rename. Fix it in the main checkout:
`npm install` in `steptix-vscode/` and `fixtures/tools/`, or re-point the two
junctions by hand. `Remove-Item` on a junction can delete what it points to, so
remove only the link:

```powershell
$m = (git worktree list --porcelain)[0] -replace '^worktree ', ''
[System.IO.Directory]::Delete("$m\steptix-vscode\node_modules\steptix-runner-core", $false)
New-Item -ItemType Junction -Path "$m\steptix-vscode\node_modules\steptix-runner-core" -Target "$m\runner-core"
[System.IO.Directory]::Delete("$m\fixtures\tools\node_modules\steptix", $false)
New-Item -ItemType Junction -Path "$m\fixtures\tools\node_modules\steptix" -Target $m
```

### Why `dist/` has to be built in the worktree

The package self-import `steptix/tools` (used
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
