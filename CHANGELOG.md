# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely. The
framework's version follows [Semantic Versioning](https://semver.org/); while
Steptix is in beta it carries a `-beta.N` suffix. The VS Code extensions keep
plain `major.minor.patch` numbers, because the Marketplace does not accept a
suffix; a beta extension is a pre-release build instead.

## Unreleased

### Changed — `SERVER_URL` is now `STEPTIX_SERVER_URL`

The variable that names the Steptix server is now `STEPTIX_SERVER_URL`, so it
cannot be mistaken for some other server's address. It matches
`STEPTIX_SERVER_API_KEY` beside it. It is read from the same places as before:
the project's `.env` or `.env.<name>`, the environment, and the machine `.env`
(`%LOCALAPPDATA%\steptix\.env`, `~/.steptix/.env` elsewhere). Error messages,
the MCP server's usage text and the runtime's readme use the new name too
(extension 0.5.170).

There is no fallback to the old name. A `SERVER_URL` line is ignored: the VS
Code extension then uses the default, `http://127.0.0.1:3100`, and the MCP
server refuses a project with "No STEPTIX_SERVER_URL". Rename the line in
each `.env`, `.env.<name>` and the machine `.env`, and rename a `SERVER_URL`
environment variable if you set one.

For the same reason, the live integration tests' `LIVE_SERVER_URL` is now
`LIVE_STEPTIX_SERVER_URL`. Set the new name when you point a live run at a
server yourself; the old one is ignored and the tests check against `:3100`.

### Changed — the default model is openai/gpt-6-luna

The built-in default model, the one `steptix init` writes into a new
project's config, and the template project's model all moved from
`openai/gpt-5.6-luna` to `openai/gpt-6-luna`. An `openai/` model goes
straight to OpenAI, so it needs an OpenAI key in `AI_API_KEY`. A project
that already names a model in its `steptix.config.json` keeps that one.

### Changed — no built-in AI gateway

Steptix no longer has a default gateway URL. Before, `ai.gatewayUrl` defaulted
to `https://llm.corp.example`, and `aibroker/` models used it without being
told to. Now `aibroker/` models refuse to run until `AI_GATEWAY_URL` is set, as
`gateway/` models already did, and nothing is sent. To keep using the hosted
broker, add this line to the project `.env`, or once to the machine `.env`
(`%LOCALAPPDATA%\steptix\.env`, `~/.steptix/.env` elsewhere):

```
AI_GATEWAY_URL=https://llm.corp.example
```

Direct models (`openai/…`, `anthropic/…`, `bedrock/…`) are unaffected. They
never used the gateway URL, and the default model is one of them. A session
whose `.env` stops setting `AI_GATEWAY_URL` now drops it rather than keeping
the last one. The request log names a direct model's provider
(`POST openai (direct)`) rather than a gateway address the request never went
to.

### Changed — runtime upgrades remove older versions, and wait while Steptix runs

Installing a version of the Windows runtime now removes every installed
version older than it, each with its own uninstaller, so its Installed Apps
entry goes too. Before, every version stayed installed, at about 170 MB each,
although only the newest ever ran. Installing an older version again, as a
rollback, leaves newer ones in place.

The installer and uninstaller also refuse to change a runtime folder that
Steptix is running from. Removing a running server's files did not fail: the
server broke later, the next time it loaded one. An interactive install asks
you to stop it (Steptix: Stop Server, or `steptix stop`) and press Retry. A
silent one exits with code 3 and changes nothing. If Windows PowerShell cannot
run the check, the install goes ahead as before but removes no older version.
See [packaging/runtime/README.md](packaging/runtime/README.md#upgrades).

### Fixed — Add check outlines what the pointer already rests on

Turning on Add check while the pointer was resting on an element drew no
outline or label until the pointer moved. Pick mode reaches the page a moment
after it is armed, and the page only drew the outline on a pointer move that
arrived after that. Now the element under the last pointer position is
outlined as soon as pick mode comes on. This was also why the root test *the
pick outline and label are never in the crop of what was picked* sometimes
timed out on CI with `last seen: 0` (#194).

### Fixed — unit tests that failed for no reason, and four things they found

A review of all four unit suites (9,338 tests) cut them to 8,945 and made
them hold under load and in any order (extension 0.5.169).
- **Gone:** duplicates and tests of code nothing calls.
- **Fixed:** the 17 tests the review found could never fail now check what
  they claim, or are gone. Sleeps and elapsed-time checks became injected
  clocks and event gates, and ports are picked by the server.
- **No sharing:** each run gets its own scratch directory, and no state
  carries from one test to the next or comes from the developer's machine.

A weekly CI job now runs the root suite in a shuffled order. CLAUDE.md
states the rules.

Fixed along the way:

- **STX020's catalogue entry no longer offers a "Reopen as Text" button.** It
  named `steptix.reopenAsText`, a command the extension never registered.
  Nothing raises STX020 today, so the button was never shown.
- **A run's "Latest runs" line is written whole.** The test file is written
  beside itself and renamed over, so an editor or another reader never sees
  it half-written. A symlinked test file is still updated at its target, a
  read-only one is still refused, and the file keeps its permissions.
- **Flick's saves of one file land in the order they were made.** Flick
  already wrote a temp file and renamed it. Now each save gets its own temp
  name, a save waits for the one before it to the same file, and on Windows
  the rename is retried while another process briefly holds the file.
- **An HTML report's token counts read the same on every machine.** They now
  use the `en-AU` format the report's date already used.

### Added — `steptix` on PATH from the runtime installer

The Windows runtime installer has a new option, "Add steptix to PATH", ticked
by default. It adds `%LOCALAPPDATA%\steptix\bin` to the user's own `Path`,
which needs no administrator rights, so `steptix` works in any new terminal.
That folder serves every installed version. It runs the newest runtime under
`%LOCALAPPDATA%\steptix\runtimes`, the same one the VS Code extension starts.
Other `Path` entries stay as written, including unexpanded `%VARIABLE%`
entries. A `Path` too long to change safely is left alone, and the installer
says how to add the folder by hand. Uninstalling the last runtime removes the
folder and its `Path` entry. See
[packaging/runtime/README.md](packaging/runtime/README.md#on-path).

A silent install (`/S`) takes the option too. Pass `/NOPATH` to leave `PATH`
alone. Silent installs and uninstalls also no longer wait on a dialog nobody
can see: the 64-bit check and the uninstaller's marker checks used to show
theirs even under `/S`. Now they stop without one: the installer exits with
code 2, and the uninstaller removes nothing. See
[Silent install](packaging/runtime/README.md#silent-install).

### Security — no high or critical `npm audit` findings, dev tooling included

`npm audit` is clean of high and critical findings in all five projects.
Every fix is a patch or minor release inside the existing ranges, except
`vitest` and `@vitest/coverage-v8`, whose floor moves from `^4.1.4` to
`^4.1.11` (GHSA-82fw-gwwq-j7x9).

- **Framework runtime:** `electron` 41.10.7 (three sandbox and cross-origin
  advisories), `undici` 7.30.0 (via `openai` and `@electron/get`), `qs`
  6.16.0 (via `express`), and `hono` 4.13.12, `fast-uri` 3.1.8 and
  `ip-address` 10.7.2 (via `@modelcontextprotocol/sdk`). Also `js-yaml`
  3.15.2 (via `gray-matter`) and `brace-expansion` 5.0.12 (via `glob`).
- **Dev tooling:** `electron-builder`'s `@xmldom/xmldom`, `js-yaml`,
  `brace-expansion` and `node-gyp`'s `undici`; in `steptix-vscode` and
  `flick-vscode`, the `@vscode/vsce`, `mocha` and `@vscode/test-electron`
  trees. Neither extension's bundle changes: their production audit was
  already clean.
- **Still open, moderate:** `file-type` 16 (GHSA-5v7r-6r5c-r473, an infinite
  loop on malformed ASF input), reached through `jimp` 0.22 and
  `@nut-tree-fork/nut-js`, which pins `jimp` exactly. Steptix only hands
  `jimp` PNGs it captured itself, so the ASF parser never sees outside input.
  Clearing it needs `jimp` 1.x and a `nut-js` release that drops 0.22.

### Changed — Steptix runs a test with nothing configured

Running a test used to need two things set up by hand: a `.env` in the
project naming `STEPTIX_SERVER_URL`, and the `steptix.serverAutoStart.command` and
`.cwd` User settings pointing at a server to start. Neither is needed now
(extension 0.5.168).

- **The server address has a machine-level home.** `STEPTIX_SERVER_URL` comes from
  the project's `.env` (and the active `.env.<name>`) as before, then the
  `STEPTIX_SERVER_URL` environment variable, then `STEPTIX_SERVER_URL` in
  `%LOCALAPPDATA%\steptix\.env` (`~/.steptix/.env` elsewhere) — the file that
  already holds the machine key — and finally `http://127.0.0.1:3100`, where
  `steptix serve` listens by default. The run log says which one it used.
- **A project needs no `.env`.** One without a `.env` now runs instead of
  failing with STX001. STX001 remains only for a `steptix.defaultEnvFile` that
  names a missing file, and a project `.env` without `STEPTIX_SERVER_URL` no longer
  fails with STX002.
- **The installed runtime starts itself.** With
  `steptix.serverAutoStart.command` empty, a run that finds no server on a
  localhost `STEPTIX_SERVER_URL` starts the newest runtime under
  `%LOCALAPPDATA%\steptix\runtimes` (`~/.steptix/runtimes` elsewhere) as
  `serve --port <STEPTIX_SERVER_URL's port> --idle-timeout 60`, in the runtime's own
  folder. The new `steptix.serverAutoStart.useInstalledRuntime` User setting
  (on by default) turns this off. A command setting, when set, still wins.
- Start Server, Stop Server, Server Status and the Copilot setup's
  "server is not on this machine" check resolve the server the same way. The
  status-bar item shows in a folder whose own env names a server or that has
  a `steptix.config.json`.
- STX003, STX010 and STX028 name the installed runtime in their fixes. STX028
  for a runtime that would not start names its folder and says it needs
  Node.js.
- **A started server gets 60 seconds to come up, not 20.** The
  `steptix.serverAutoStart.readyTimeoutSeconds` default rises to 60. A first
  start is the slow one, and on a busy machine it could exceed 20 seconds and
  fail with STX028. A server that comes up sooner is used as soon as it
  answers; only one that never does waits out the full 60 seconds.

The runtime installer's end-to-end test now proves this: a fresh profile with
no Steptix settings at all and a project with no `.env` runs a test, and the
server is started from the installed runtime on the port the machine `.env`
names.

### Added — the version names the build: commit, and whether it was modified

Between betas every build reports the same version, so the version alone no
longer says which code is answering. `npm run build` now stamps
`dist/build-info.json` with the commit it was built from and whether the
working tree had uncommitted changes (tracked or untracked), and that is
reported beside the version:

- `steptix --version` and `steptix status`: `1.0.0-beta.1 (b700473)`, or
  `1.0.0-beta.1 (b700473, modified)`.
- `GET /health` and the MCP `server_status` tool: new `commit` and `modified`
  fields; `version` is unchanged.
- The Steptix status bar keeps the short version; its tooltip, the "server
  started" message and the run log show the commit.
- The scoreboard's `fw` takes its commit from the stamp, so it names the code
  that ran rather than whatever the checkout had moved on to since start-up.
- `npm pack` and `npm publish` build first (`prepack`), so a package carries
  a stamp of the commit it was packed from, not whatever `dist/` was last
  built. Commit before packing and the stamp names exactly that commit.

Both are `null` (and the version is shown alone) when unknown: built without
git, outside a checkout, or running from `src/` (`npm run dev`), where the
stamp would describe some other build. A server predating the fields omits
them, and every client reads that as unknown.

### Changed — Steptix is beta software: version `1.0.0-beta.1`

The framework claimed `1.0.0`, which under semver promises a stable surface.
It is not one yet, so the version is now `1.0.0-beta.1`. Test-file syntax,
configuration keys, CLI options and the Sessions API can still change between
betas without a deprecation period. `steptix --version`, the server's
`/health`, the MCP server, the Steptix status bar and the scoreboard's `fw`
field all report the new version. Nothing compares versions, so no behaviour
changes.

Later betas count up (`-beta.2`, …), then `-rc.N`, then `1.0.0`. A tools
project that depends on the package needs `"steptix": "^1.0.0-beta.1"`: a
plain `^1.0.0` range does not match a pre-release.

The Steptix extension says so too. The Extensions panel lists it as
"Steptix (Beta)", and `npm run package` in `steptix-vscode/` passes
`--pre-release`, so every `.vsix` is marked as a pre-release build — which is
how the Marketplace publishes a beta. Its version stays `0.5.x`: an odd minor
number is the Marketplace's convention for a pre-release, and the first
release takes the next even one or `1.0.0`. The "Steptix" output channel and
the status bar keep their names.

### Changed — the product is now Steptix

AI UI Automation and its VS Code extension, TestBench, are one product now,
called Steptix. Every name a user types or a file carries changed with it, in
one go and with no fallback to the old names:

| Was | Now |
|---|---|
| package `ai-ui-automation`, CLI `aiui` | package `steptix`, CLI `steptix` |
| `aiui.config.json`, `.aiui/`, `.aiui-codebehind-cache/` | `steptix.config.json`, `.steptix/`, `.steptix-codebehind-cache/` |
| `AIUI_*` environment variables | `STEPTIX_*` |
| `%LOCALAPPDATA%\aiui\` | `%LOCALAPPDATA%\steptix\` |
| MCP server `aiui` | MCP server `steptix` |
| extension `pkent.testbench-native`, "TestBench (Native)" | extension `pkent.steptix-vscode`, "Steptix" |
| settings and commands `testbench-native.*` / `testbench.*` | `steptix.*` |
| error codes `TB001`–`TB032` | `STX001`–`STX032`, same numbers |
| folder `testbench-native/` | `steptix-vscode/` |

The new extension ID is a different extension to VS Code: uninstall the old
one, and move settings across. The Copilot bridge token lives in the old
extension's secret storage, so run "Steptix: Use Copilot for AI" once more.

Entries below this one, and resolved issues, keep the names they were written
with.

### Fixed — an upload step can name an absolute path on Linux and macOS

A leading `/` in an upload path was always read as "relative to the test
file", because that is how a Windows author writes `\attachments\logo.png`.
On Linux and macOS that made a real absolute path such as
`/srv/files/x.png` impossible to upload from, where on Windows a
`C:\files\x.png` always worked. A rooted path is now looked for beside the
test file first, on every platform, so existing tests behave exactly as
before. On Linux and macOS, if nothing is there, the path is used as
written. When neither place has the file, the error names both. The
project fence applies as before.

### Fixed — the unit tests build first, and pass on Linux

`npm test` (root and `steptix-vscode/`) now runs `npm run build` first.
Several suites run the compiled `dist/` on purpose, and a stale one made
them test old code with no warning. On one Linux checkout that accounted
for 67 failures. Two test fixtures hard-coded Windows paths
(`api-server-cdp`, 77 failures; `stats-aggregate`, 1) and now use paths
native to the platform.

### Fixed — a Run on a machine with no key starts the server instead of refusing

On a machine with no `STEPTIX_SERVER_API_KEY` anywhere (not in the project's
`.env`, not in the environment, and no `%LOCALAPPDATA%\steptix\.env`), Steptix
refused every Run with STX003. It asked for the key before the server check.
So the auto-start, whose `steptix serve` is what generates the machine key,
never got to run. Steptix now reads the key once the server is ready: a
configured auto-start brings the server up, the server writes the key, and
the Run goes ahead with it. With a server already running and still no key,
STX003 stands, because Steptix cannot learn that server's key, and its fix
text now says so. Record Steps behaves the same way.
stories/machine-key.md records the case as verification rule (10).

### Fixed — an unreadable machine key file no longer leaves a test stuck "running"

Moving the key lookup after the server check (above) also moved it after the
Run is marked active. So a `%LOCALAPPDATA%\steptix\.env` that exists but
cannot be read (permission denied, a folder by that name, a lock held by
another program) threw past the cleanup that clears that. The file stayed
"running" with no message, Run did nothing, Stop could not clear it, and
only a window reload did. That read now fails the Run with the new
**STX007**, which names the file and the read error.

### Added — an Apache-2.0 licence

Steptix is licensed under the Apache License, Version 2.0, as Playwright is.
`LICENSE` and `NOTICE` sit at the repo root, both extensions carry a copy of
`LICENSE` so it ships inside each `.vsix`, and every `package.json` declares
`"license": "Apache-2.0"`.

The Steptix extension's bundles carry copies of third-party code (today
React, React DOM, scheduler and jsonc-parser, all MIT), and their licences
require the notices to travel with it. `npm run build` now ends by writing
`dist/THIRD-PARTY-NOTICES.txt`, which ships in the `.vsix`. The list is read
from the bundles' source maps, so it is exactly what was bundled. The build
stops on a bundled package with no licence file, on a licence outside MIT,
ISC, BSD, 0BSD and Apache-2.0 (an `OR` with one of those passes), and on any
file in `dist/` no source map accounts for, such as a font or stylesheet
copied from a package; an `OVERRIDES` table in the script settles the rare
package the rules cannot. Vite's modulepreload polyfill is switched off: it
is injected from a virtual module, so no map names it.

### Added — a first-try scoreboard: `aiui stats`

Every run now keeps a short record, on this machine only, of each AI action
and step: the kind of selector the model chose, whether it worked the first
time, the model, the site, and each step's model calls and tokens. The lines go
to `%LOCALAPPDATA%\aiui\stats\actions-YYYY-MM.jsonl` (one file a month, kept six
months), are never sent anywhere, and are masked with the same secret set as
the report. `aiui stats` adds them up: first-try success by selector form,
site, model, rules version or test; `--failures` and `--costly` list the steps
behind the numbers, each with a `file:///…#step-N` link that opens the report
at that step; `--json` gives the same to other tools. Recording costs about
0.65 ms a step and no extra model or page calls. Steps that asked no model are
not counted, a step you stop is not counted as a failure, and test-suite and
compile runs are tagged so they stay out of the default view. `AIUI_STATS=off`
turns it off for the machine, `"stats": { "enabled": false }` for one project.
See [the spec](docs/specs/SPEC-scoreboard.md).

Along the way: every model call now records its token usage on the report's
interaction, including regenerated assertion code and the calls of failed
attempts, which were dropped before; report step cards carry anchors
(`id="step-11"`); and the Electron runner masks section-row and skill-argument
secrets in its report, panel and prompt history, as the CLI and Sessions API
now do.

### Fixed — an action the framework does not have fails the step instead of passing it

A model that answered "Tick the I agree box" with `{"action": "check"}` used to
pass the step green with the box unticked: the parser kept the unknown type
with a warning, and the executor's fallback reported success. The next step
then failed on the wrong line, or the test passed having done nothing. It had
only ever been patched one near-miss at a time (`goBack` → `back`,
`refresh` → `reload`).

Now a reply holding an unknown action type is refused as a whole, before any of
its actions touches the page, so a retry never starts from a half-changed page.
The step's error is one short sentence (`Unknown action type "check" — the
framework has no such action, so nothing was done on the page`), and the
model's reply stays in the report with the ✗ on that action. The retry lists
the actions that act on the page, leaving out the ones that can end a step
having done nothing (`noop`, `prompt` and the like), keeps the selector in its
account of what failed without telling the model to pick another one, and gives
it an honest way out: when no action does what the step asks, it reports the
step unachievable with an `assert` whose `holds` is false, rather than typing
or clicking something the step never asked for. The page loop now honours that
`holds: false`, which rule 24 already described but the parser used to reject,
by failing the step with the model's evidence and no retry. Measured with the
real model: `check` recovered as `click` 5 times out of 5, and a misplaced
`[use ai]` line (which the model turns into an `ai` action) went from passing on
an invented name typed into a field 4 times out of 5 to failing honestly 5 times
out of 5 with the page untouched.

Action names are also matched regardless of case and separators (`Click`,
`SWITCH_PAGE`, `read_table`). The action types the step loop handles itself are
refused as a framework bug if they ever reach the page executor, and its
`switch` is now checked for completeness at compile time, so a new action type
cannot be added unwired.

### Fixed — a `[use ai]` step that needs a secret fails instead of storing `***`

A `[use ai]` step's text reaches the model with secret-named values masked as
`***`, but the model was not told what that meant. "Repeat {{password}} back
and store it in echo" stored the literal `***` and passed, and every later step
used three asterisks. When a step's text had a value masked, the model is now
told `***` is a value hidden from it and to reply with an error if it needs it.
A value that still contains the mask is refused rather than stored, in the
spellings an echo takes too (`* * *`, `\*\*\*`, `＊＊＊`, `*-*-*`). Whether the
model refuses or answers, the error names what was hidden (never its value),
and a variable hidden only by its name is said to be: `{{keyword}}` contains
"key", and renaming it lifts the mask. A step that masked nothing is unchanged,
so an answer that legitimately contains asterisks still passes.

Inside a skill or a looped `### Section`, the step never got that far: a skill
argument or a row value is written into the step's text before the step runs,
so no placeholder was left to mask, and a `password` column reached the model
in clear. The step's own words are now masked with the run's secret set, the
same set the report is masked with. See
[issue 060](issues/resolved/060-use-ai-step-stores-a-masked-secret-and-passes.md).

### Fixed — skill arguments and looped-section rows stay masked in the run's output

The CLI never counted a skill call's arguments or a looped section's row values
as secrets, so a `password` column printed in clear on the console, in the
report and in the run log. The Sessions API did count them, but merged them
with the test's variables into one map, which keeps one value per name. The
second row's `password` evicted the first row's from the mask set, and
`[skill: login password="{{password}}"]`, the usual way to hand a login skill
the test's password, evicted the real password in favour of the placeholder
text, so it printed in clear for the whole run. Both now pool each call's and
each row's values into the secret set instead. The Electron app does the same
for a `[use ai]` step's text; its other output still leaves them out.

### Added — Record Steps: write a test by using the app (TestBench)

Press **Record** in TestBench (or run **Record New Test**), use the application
in the test's own browser, and the numbered steps appear in the file at the
cursor as you work, in the handbook's style — the model drafts them a moment
after each action and the recorded lines are highlighted while it does. Press
**Stop** for the final version; one Ctrl+Z after Stop takes the whole recording
back, and **Cancel** removes it. Each draft call is sent
the page's own description of what you clicked plus a cropped screenshot around
it. An action is a click or a drag, Enter or Tab, or the browser's Back,
Forward or Refresh; typing, selecting and ticking ride with the next action.
Every typed value becomes a `{{parameter}}` with its value under
`## Parameters`; a password never leaves the browser — its step reads
`{{password}}` and its value comes from `.env` — and secret fields are painted
out of every screenshot. **Add check** turns your next click into a
`Verify …` step instead of a click. A ✕ drops a misclick. See
docs/specs/SPEC-record-steps.md.

The recording also has **controls in the browser**: a small bar docked in the
page (bottom-centre by default; drag it to any corner or edge, or minimise it
to a pill — it remembers) with the time and action count, **Pause** (browse
anywhere, nothing is recorded; resume where you left off), **Add check**,
**Add step** (type any step — a `Verify …` or anything else — and it goes in
exactly as written, locked in with everything recorded before it), **Undo**,
**Stop** and **Cancel**, a status line with the last step, and a Steps so far
drawer. Shortcuts: Alt+Shift+P/C/S/Z/M/R. It works on strict-CSP pages, is
painted out of every screenshot the model sees, and its own clicks and keys are
never recorded. A step you **type in the test file** during a recording joins
it the same way: it is kept exactly as you wrote it, the recording numbers
around it, and the next steps go after it. Pause, Resume and Add Step to
Recording are also commands; `testbench-native.recordSteps.browserToolbar`
turns the bar off. See stories/testbench-record-toolbar.md.

You can also **change what has been recorded** while you record, and no step
is ever locked against you. In the bar's Steps so far drawer, click a step to
reword it, press ✕ to delete it, or `+` between two steps to add one there;
in the test file, just edit or delete the line. A reworded step keeps your
wording through every later draft and the model writes no second step for
what it describes; deleting a step the model wrote also drops the recorded
actions behind it, so no redraft brings it back, and Restore (or Ctrl+Z in the
file) puts both back. See stories/testbench-record-edit-steps.md. Server:
rebuild and restart; TestBench 0.5.159.

### Added — `drag` and `reload` steps

A step can now drag one element onto another and reload the page:
`Drag the Invoice 1043 card onto the Paid column` and `Reload the page` run like
any other step. The model has two new actions for them — `drag` (the element
dragged and the element it is dropped on, both by selector; it drives HTML5
drag-and-drop and pointer-event sortables alike) and `reload` (the browser's
reload button, waiting for the page as a navigation does). Both compile to
code-behind (`dragTo`, `page.reload()`), and a report row for a drag says which
element went onto which. Before this, a drag had no action at all, and a
reload — deferred when back and forward were added — could only be written as a
navigation to the same address, which is not the same thing. Added because
Record Steps records both (docs/specs/SPEC-record-steps.md §4), and a recorded
step has to be able to run.

### Fixed — the selector rules no longer steer the model into selectors that match nothing

Rule 3 of the step prompt recommended `tag:text-is("label")` for short labels
and `[role="button"][name="..."]` as "accessible role + name". The first
matches nothing when the label sits in a child element, which is how component
libraries write buttons (`<a role="button"><span>Join</span></a>`). The second
is plain CSS, looks for an HTML `name` attribute, and matches nothing on most
buttons. On 17 runs against a real site, all 19 failed actions used one of the
two. Each one waited out a 10-second timeout before a retry, and a dropdown
option whose text sat three elements deep never passed at all.

The rule now recommends Playwright's `role=button[name="..."]` form, which
matches the name a screen reader announces however deeply the text is
wrapped. It says which elements have a role (an `<a>` without `href` or a
clickable `<div>` has none), that `aria-labelledby` or `aria-label` replaces
the text as the name, to copy the name from the DOM snapshot rather than the
screenshot, and to scope with ` >> `. When a name matches nothing because it
holds something the snapshot cannot show (an icon glyph, a CSS-drawn arrow or
asterisk), the model falls back to `:has-text`. `:text-is` stays for elements
item 3 does not cover whose text sits directly inside.

The rest of the framework now takes that form everywhere a model-written
selector goes. `expand`, `find`'s scope, the readTable structure question and
the `count` and `attribute` waits used to run the selector through
`document.querySelector`, which throws on `role=` and ` >> `; they resolve it
through Playwright now, and the two waits honour `frame` as well. A `role=`
condition on a wait with no `waitType` is recognised as a selector instead of
waiting out its timeout as text. And an iframe written into the selector with
` >> ` (`#pay-frame >> role=button[name="Pay now"]`) is moved into `frame`
correctly; it used to leave the selector as `>> role=…`, which Playwright
rejects. See
[issue 062](issues/062-selector-rules-steer-the-model-into-selectors-that-match-nothing.md).

### Added — files that loop and decide now compile, conditions included

`aiui compile` refused any file with a `While`, `Repeat … until` or `For each`,
and Run & Compile refused whenever the steps it would compile touched one. Both
now compile it: each line of a loop body gets one code-behind entry, generated
from the first pass that ran it and replayed on every pass, with anything that
changes per pass (a `For each` item) read through `step.getVar`.

The conditions compile too. An `If`, `Else if`, `While` or `Repeat … until`
line whose condition looks at the page gets an entry with a `condition`
function that answers true or false, so a compiled test makes no model call to
decide — before, every such line asked the model on every visit, and a project
with `ai.allowInRuns: false` could not run one at all. A condition is decided
from its values first, then by its entry, then by the model; a chain is
decided in code only when every member can be. An entry that throws paints ⚠
and the model decides for the rest of the run; a compiled loop that reaches
its cap asks the model once whether it should really carry on. `aiui compile`'s
replay also checks the compiled conditions against the recorded run, visit by
visit, and warns — naming the step that captured the list — when a loop ran a
different number of passes than it did on the recording (a warning, because
the list may really have changed between the two runs). `Otherwise` and `For
each` have nothing to compile. The Electron app
runs no code-behind and is unchanged.

Also fixed on the way:

- Run & Compile now names the steps a decision skipped — an untaken branch, a
  loop that ran no passes — as not attempted, instead of saying nothing
  (issue 053).
- `POST /codebehind/compile` on a file with a chain failed its recording run,
  and on a file with a loop ran the tail twice; both now compile.
- TestBench no longer paints a refused compile as "✓ Nothing to compile", and
  keeps a condition's code mark on its line after the section it ran finishes.
- `step.getVar('order.id')` inside a skill body reads the `For each` item's
  field (it answered `undefined`).

TestBench 0.5.150. Server: rebuild and restart.

### Removed — the step cache; code-behind is now the one way a step replays

The step cache is gone. With `cache.enabled` on in `aiui.config.json`, or
`## Config: cache: on` in a test, a passing step's AI actions — its CSS
selectors — and the JavaScript generated for its assertions were saved under
`<project>/.cache/<env>/<test>/` and replayed on the next run without a model
call, painted ⚡ in the report and in TestBench. What it replayed was a recorded
transcript nobody reviewed, and several of its known bugs replayed the wrong
action without saying so. Code-behind does the same job with code you can
read: `aiui compile` writes a `.steps.ts` beside the test, and a compiled step
runs as code, marked `</>`. It is now the only replay mechanism.

In a project that used the cache, delete the `cache` block from
`aiui.config.json` — a leftover one is ignored, with a warning when the config
is loaded. Delete any `## Config: cache:` lines from your tests; `cache` is now
an unrecognised key, which is ignored. And delete the project's `.cache/`
directory, which nothing reads any more. The "TestBench: Clear Cache for This
Test" command and the ⚡ status are gone with it.

What changes for a run: every step without a code-behind entry calls the model
on every run, and that includes the code for its assertions, which was cached
too. A test that relied on cache hits will now take longer and cost more per
run until you compile it. A table read whose structure the model had to name
(`readTable`'s structure question) is still asked at most once per structure
per run, and later reads in the same run reuse the answer, but the answer is no
longer kept between runs, and code-behind does not compile a table read yet.
`aiui compile` always records from a live AI run now; before, a step it recorded
could be a replay from the cache.

### Added — a step can fail in the author's words, and fail without stopping the run

A step failed when the model or the code-behind could not do what the line said,
the message on it was whatever the framework produced, and every failure took
the run down. So there was no way to say *if this value is wrong, fail, and put
my sentence in the report*, no way to make a red `Verify` say what the author
meant rather than what the model compared, and a step that may legitimately
fail — a banner that is sometimes there, an informational check — had to be
rewritten as a conditional or it ended the run.

Three forms now. A step ending `then fail the test with error "…"` is the third
verb of the `return` / `stop` grammar: the model judges the condition against
the live page and, when it holds, the step fails with that message and the run
stops. A step ending `otherwise fail the test with message "…"` is an ordinary
step whose final failure is renamed. A step ending `otherwise continue` — or
`otherwise continue with warning "…"` — is an ordinary step whose failure the
run survives. A line that is nothing but `Fail the test with error "…"` fails
the run with no model call at all, which is what makes it the natural tail of an
`Otherwise` at the end of a decision.

```markdown
6. Verify the page title contains "Dashboard" otherwise fail the test with message "Sign in did not reach the dashboard"
7. Verify the footer shows the build number otherwise continue with warning "Build number missing"
9. If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"
```

A deliberate failure is not retried: the author asked for it, and a retry would
hand the model *this failed, try something else*, which is the one nudge that
could turn it into a false pass. The AI failure diagnosis is skipped for the
same reason — the cause is already written. The message is interpolated like any
other step text — in a `fail` condition's `with error "…"` and in an `otherwise`
tail's message alike — and masked on its way out, so a `{{password}}` inside one
cannot leak through the report, the wire or the log. A tolerated failure keeps
`status: failed` — it did not do what it said — paints amber rather than red,
and is counted apart: *7 passed, 1 tolerated*. The run's status excludes it, so
a run whose only failures were tolerated passes, and neither the pass count nor
the fail count absorbs it. Inside a `While`, a `Repeat`, a `For each` or a
looped section the loop keeps looping, because the pass did not end.

The model never sees an `otherwise` tail. It is handed the body alone —
otherwise a model told "otherwise continue" reasons that the step is optional
and does nothing, and one told "otherwise fail with message" judges the check
itself — while the report's instruction line, the console line and the run log
all keep the line as written. A `fail` condition is different: the model reads
that whole line, because judging the condition is the job.

Code-behind gains `step.fail(message)`, which throws what a failed
`step.expect` throws, so the existing rule applies unchanged — a real failure,
never healed under AI. A conditional `fail` compiles into an entry that reads
its condition and calls `step.fail` with the authored message, and a step with
an `otherwise fail … with message` tail compiles with that message as its
`step.expect` message, so a replay fails in the author's words for no tokens:

```ts
{
  source: 'If {{a}} is "peanuts" then fail the test with error "The variable value was peanuts. Expected apples"',
  async run({ step }) {
    if (step.getVar('a') === 'peanuts') step.fail('The variable value was peanuts. Expected apples');
  },
}
```

On the wire, `step:fail` gains `deliberate`, `tolerated` and `warning`, all
optional: a client that does not know them paints the ✗ it always did, which is
the safe direction for all three. `results[]` rows carry `tolerated` — and
`warning` beside it — with `status` staying `"failed"`, the shape a user-stopped
step already had. A warning you wrote leads every surface that shows the
failure: the first line of the TestBench hover, the run log's `⚠ step 7 failed —
continuing: Build number missing (the footer had no build number)`, the Electron
panel's amber line, and an MCP agent's row and summary. What actually went wrong
is never dropped — it keeps its place underneath.

A tail is read on prose steps only, and each line that does not take one says so
in its own way. A `[tool:]` or `[skill:]` step carrying a tail is refused by
name at parse time — both have a grammar of their own the tail is not threaded
through, and a tail parsed and then ignored is worse than a refusal — and a
`Set` is refused by the `Set` parser, as a malformed `Set` whose message names
what is wrong with the line. A `### Section` call is the one to watch: a section
is matched by the exact text of the calling line, so `Sign in otherwise continue`
no longer calls `### Sign in` at all — it becomes an ordinary prose step with a
tail on it. Write the tail on a step inside the section instead — which is also
why a tool call has no wrapper to hide behind, and why its refusal points at a
step after the call instead. A line that asks for two endings at once, `If x then
return otherwise continue`, is refused by name rather than resolved.

Two smaller things a client gets right that it did not have to think about
before. Stepping (F10 / F11) pauses after a tolerated step, as it does after a
pass — both are outcomes the run continues past, and only a stopping failure
skips the pause. And a *compiled* deliberate failure is reported in the author's
words rather than as broken code: `step.fail()` throws what a failed
`step.expect` throws, so it arrives flagged as coming from the code-behind, and
every surface used to frame the author's own sentence as an entry defect.

### Added — a step can leave the flow it is in

A test ran top to bottom and the only way out early was to fail. There was no
way to say "if we are already signed in, skip the rest of this section", so
authors wrote a conditional on every line that might not apply, or wrote a
tool.

A step ending `then return` — or `then stop`, `stop here`, `stop running the
remaining steps` — now ends the flow it is in, as a pass: the rest of a
`### Section` body, the rest of a skill body, or the rest of the test when the
step is in the main flow. The condition is judged against the live page the way
an `If …` step is. Both verbs also take a tail — `here`, `running the steps`,
`running the rest of the steps`, `running the remaining steps`, `running the
below steps`, `running the following steps` — and a step whose *whole text* is
one of those, with no `If`/`When` in front of it, is unconditional and costs no
model call at all. `Return` is one of those; so is `Stop running the remaining
steps`.

The steps a return leaves behind are reported `skipped` with a reason —
*Not run: step 7 returned from "Sign in" — If the page title contains
"Dashboard" then return* — rather than passed, and the report header counts
them separately, so a run that returned reads as a pass with N skipped rather
than as a green run that did the work. The number is the expanded step index,
which is what the report rows and the run log count by; the text after the dash
is the returning step as authored, clipped to 80 characters, which is what you
can find in the editor. It is not read as a timeout either: the runner's
step-count inference has been replaced with an explicit flag set where the
timeout actually fires.

The MCP one-liner says it too — `PASSED — 3 passed, 4 skipped (a step returned
early) of 7` instead of `3/7 steps passed`, which read as four failures on a
green run. A step the server declined to run unattended (`[input:]`,
`[interactive]`) is also skipped, and is counted and worded apart —
`2 skipped (need a human)` — because the two want opposite reactions.

The HTML report's new Skipped tile counts **every** skipped row, which includes
one that predates this feature: the unmatched branches of a conditional group
have always been recorded `skipped`, and were simply never counted. So a test
with `If …` groups in it now shows a Skipped tile where it showed none. Nothing
about those runs changed; the header stopped leaving them out.

Only a line that opens `If`/`When`, or a line that is nothing but the tail, is
flow control. `Click the details link then return` stays an ordinary step —
after an action, "then return" reads as *navigate back* — and a typo in the
verb stays prose. The grammar errs towards missing a return, because a missed
one fails loudly downstream while a spurious one would pass a run that did no
work. A hook may not return, and the line is refused in `## Hooks` at parse and
in `execution.defaultHooks` at config load.

Code-behind can return too. `step.exit()` is new on the step API, the code form
of `return` / `stop`: it ends the entry wherever it is called from — a nested
helper, the middle of an `if` — and the step passes and the flow it is in ends,
exactly as the AI step's return does. A conditional flow-control step therefore
compiles like any other, into an entry that reads the condition off the page and
calls `step.exit()` when it holds, so a replay returns for no tokens:

```ts
{
  source: 'If the page title contains "Dashboard" then return',
  async run({ page, step }) {
    if ((await page.title()).includes('Dashboard')) step.exit();
  },
}
```

The unconditional form is not compiled at all — it already runs without a model,
so an entry could only make it slower, the same exemption `Set` has.

`step.exit()` from an entry whose step does **not** say it returns fails that
step, and does not heal it under AI: the entry is not broken, and the rule it
broke is one no re-planning can satisfy. The markdown is what a reader of the
test sees, so it has to say what the code does. The fix is one line of markdown,
which is what the failure says.

### Added — "Capture the current page URL" can now be said

No element carries the page's address as an attribute, so a step asking for the
current URL had no expression in the action vocabulary at all. The model reached
for `@url` regardless — the only shape available to it — `getAttribute('url')`
returned null, and the read stored the empty string. Nothing failed at the
capture; the run fell over later, on a step navigating to nothing, wearing the
breakpoint machinery's name in its error message.

`attribute: "url"` is now real: the address of the element's own document, so a
read inside a frame reports that frame. A page that genuinely carries a `url`
attribute still wins, following the same attribute-first precedent as `href` and
`src`, so nothing that was readable before has become unreadable.

### Fixed — one stale compile proposal answered the next compile's question

TestBench holds a single pending code-behind proposal for the whole window,
cleared only by Apply or Discard. A compile that did neither left its proposal
standing, and the next compile's "is there a proposal yet?" — the context key
that gates Apply, and the live tests' waits — was answered by the previous run's
files before the new run had produced any. Six live tests failed as one cascade.

A compile now parks any pending proposal before it starts, and puts it back if
it produces none of its own, so a compile that fails no longer costs the author
the proposal they were still deciding about.


### Fixed — a compiled post-condition that cannot go red

A post-condition that always passes is the same as having none, only harder to
notice. On a capture step the instruction names no expectation — "Count the
rows [as: n]" says nothing about what n should be — so the model reached for
the only value to hand and compared it to itself:
`step.expect((await rows.count()) === rowCount)`, which re-reads what it has
already stored and passes just as happily on an empty page.

The generation rule now says a post-condition has to be able to fail, and what
to assert when the step states no expectation: that the thing you read from was
really there and really populated, rather than that a number equals itself. The
same step now waits for the first row and asserts the count is non-zero.

### Added — Upload steps now work end to end

The `upload` action has been in the parser, the executor and the step cache for
a while, but nothing ever told the model it existed, so a step naming a file was
guessed at as a `type` or a `click`. The prompt now carries an upload rule, and
a path written in a step — `\attachments\logo.png`, backslashes or forward
slashes — is resolved against the folder the test file is in, so a test moved
along with its `attachments/` folder keeps working. Paths are fenced to the
project root, and the file has to be readable by the server process, which is
where the bytes are actually read.

The uploader most real sites use is a styled button with its
`<input type="file">` at `display:none`, and both ways of driving it now work:
targeting the input directly (Playwright sets files on a hidden input quite
happily), or clicking the button and answering the file chooser it opens. The
DOM snapshot keeps a hidden file input's `id`, `name`, `type`, `accept` and
`multiple`, so the model can name it in the first place, and `filePaths` sends
several files in one action.

A missing file now fails the step immediately, before any selector is evaluated,
with a message naming the absolute path that was tried and the folder it was
resolved from. It costs no AI retries — nothing the model does can make a file
appear — and it neither invalidates a cached plan nor throws away a compiled
code-behind entry, since the plan was fine and only the file was missing.
Compiled entries resolve their paths through `step.filePath(...)` rather than
freezing an absolute one. All of it is tested against the Documents page added
to the SecureBank fixture app earlier.

### Fixed — a compiled post-condition now waits for the state it asserts

Compiling the upload acceptance test left three steps needing AI, and the
reason was not uploads at all. The post-condition the model wrote read the
status message once and compared it — and the page that message lands in is a
single element that keeps the PREVIOUS step's text until the new one arrives.
Compiled code gets there a millisecond after the click, with the request still
in flight, so it read the old message and the assertion failed. A bare
`waitFor()` did not save it: its default state is `visible`, which that element
already was. Under AI it never showed, because the runner settles the page after
each action and the next model turn costs seconds of think time, so the text has
always arrived by the time the AI looks. Only compiled code is fast enough to
lose the race.

The post-condition rule now says to wait for the new state and then assert, and
names the waiting forms a code-behind entry actually has — a text-filtered
locator, or `page.waitForFunction` — since with no imports, Playwright's
`expect(locator).toHaveText(...)` is not among them. A static check backs it up
on the one re-ask the other backstops share, catching a one-shot read fed into
`step.expect` with nothing waiting in front of it. Nothing here is
upload-specific: any step shaped "click something, then assert on text the
server updates" had the same race, and the same generated file had it a second
time on a table filled by a later fetch.

The upload acceptance test now compiles all 14 of its steps as code and replays
them with no model calls at all.

### Fixed — a failed step no longer claims retries it never spent

The failure a step reports was built from `execution.retries` rather than from
what actually happened, so it always read "Failed to execute step after 2
attempts" even when only one was made. That was harmless while every failure
burned every retry; it stopped being harmless now that an upload naming a
missing file deliberately ends after the first attempt. The count now comes
from the attempts made, the `retried` flag is only set when a retry really
happened, and the console line drops "after retry" when there wasn't one.

### Added — Live coverage for verify steps, including two that must go red

Verification had almost no live coverage. Two steps existed —
`cache-replay.md`'s "Verify the page URL is exactly about:blank" and
`sections-live.md`'s DOM-free "Confirm the browser is showing a page" — and
neither suite asserted anything about the verification itself: one asserts the
⚡ cache glyph, the other asserts section expansion. Nothing read a real value
off a real page, and nothing proved a verify could fail.

`testbench-native/tests/integration/live/verify-assertions.test.cjs` now drives
three fixtures against the portfolio page in `fixtures/test-app`:

- **`verify-assertions.md`** — one step per common verification shape, all
  expected green: text equality, exact currency, negation, threshold, sign,
  substring/row lookup, count, cross-element sum, ordering, field value,
  disabled and enabled control, absence, per-row status badge, empty state,
  and an async value read after the action that changes it.
- **`verify-near-miss.md`** — expects `$148,320.51` against a rendered
  `$148,320.50` and **must fail**.
- **`verify-false-negation.md`** — asserts the Cash & Savings card is NOT
  `$24,582.90` when it is exactly that, and **must fail**.

The two red fixtures are the load-bearing half. The model both writes the
assertion code and grades the result, so a file of passing verifies cannot
distinguish "verification works" from "verification is a no-op that returns
true". Both are near misses rather than absurd values on purpose: one cent is
only caught by an assertion that actually compares the numbers, and the false
negation is only caught by one that evaluates the "NOT" rather than dropping
it — which is what the passing `NOT $60.00` step in the first fixture pairs
with to pin the direction.

Neither red case relies on the retry loop behaving: a failed assertion throws
`StepFailureError`, so with the default `execution.retries: 1` each must-fail
step is attempted twice before settling. Both attempts fail because the page
value genuinely differs. Two existing behaviours keep that retry from becoming
a "try until green" loop, and this suite is what would notice if either
regressed — `evaluateAssertion` regenerates assertion code only when the code
*throws*, never on a structured `pass: false`; and assertion failures never
reach `collectedFailures`, so the retry prompt carries no hint about what the
assertion expected or what it got.

`fixtures/test-app/assertions.html` grew the targets those shapes needed and
previously had nowhere to read: a Transfer panel (a field holding `50.20`, a
disabled Transfer button, an enabled Cancel beside it, and deliberately no
error node, so "verify no error is shown" has something real to be right
about), a Scheduled Payments table that finally renders the `.badge.pending`
and `.badge.closed` styles the stylesheet had always defined but never used, a
Closed Accounts table with a header and an explicit empty state, and a
settlement figure that resolves 2s after Refresh. Existing expectations are
untouched — 10 holdings, 5 alerts, 50 transaction rows, and the holdings sum
still matching `$52,150.00`.

### Added — SecureBank fixture: a Documents page for file-upload steps

`fixtures/test-app` gains `/documents`, the page the upcoming file-upload
step support ([stories/file-upload-steps.md](stories/file-upload-steps.md))
will be tested against: three upload controls (a plain `<input type="file">`,
a styled "Choose file" button whose input is hidden, and a multi-file field),
an "Uploaded documents" table fed by a real multipart `POST /api/documents`,
and server-side rejection of disallowed extensions (400) and files over 1 MB
(413). `GET`/`DELETE /api/documents` list and clear the in-memory store so
concurrent runs can isolate themselves. Sample files live beside the tests
that use them (`fixtures/tests/attachments/`,
`templates/init/tests/attachments/`), and
`templates/init/tests/securebank-upload.md` is the markdown test part 2 of the
story has to make pass — today the model is never told the `upload` action
exists, so it is expected to fail.

### Fixed — TestBench: a failed code-behind step now says what failed, where you're looking

When a code-behind step failed in TestBench, the error was one line in the
scrolling Output log — and in the worst case (the entry threw, the step fell
through to AI, and the AI attempt failed too) the code-behind crash was
dropped before it ever reached the client. Now the failure text is pinned to
the step line everywhere the marks are:

- **Editor hovers** — hovering a ✗ shows the step's error (labelled
  "code-behind failed" when it came from the entry); hovering a ⚠ now leads
  with the actual crash and the `.steps.ts` file instead of only the static
  Repair hint. Hovers survive window reloads with the rest of the run state.
- **TestBench panel** — the error renders inline under the failed step's row
  in the Steps list (red for ✗, yellow for ⚠), so no log-scrolling. The ⚠
  log line is now warning-coloured, and a failed heal logs both errors.
- **Failed heals keep their story** — a step whose entry threw and whose AI
  retry also failed now carries `codeBehindStale` on the `step:fail` wire
  event, in the report (the ⚠ block renders alongside the failure), in the
  last-run sidecar (so `--only-stale` / Repair see the broken entry), in
  Test Explorer failure messages, and in the MCP run summary. `step:fail`
  also carries `fromCodeBehind` so a failed `step.expect` / strict replay is
  distinguishable from an AI failure.
- **"Stale" no longer implies "recovered".** `codeBehindStale` used to reach
  only passing steps, so several surfaces read it as "healed". Now that a
  failed step can carry it, anything meaning *healed* asks `isHealedStep`
  (flag **and** `status === 'passed'`): the run-complete `healed` summary,
  the report's ⚠ badge — a failed step reads "⚠ code-behind failed" rather
  than claiming it "ran under AI" next to its own ✗ Step Failed block — and
  the report's "Stale" stat, which counts a failed step as AI, not stale.
- One phrasing for the whole failure vocabulary: `describeStepFailure` in
  runner-core (mirrored for the webview bundle and pinned by a copy-parity
  test) replaces five hand-written variants that had already drifted apart —
  the same event rendered "(code-behind) X" on one surface and "Code-behind
  failed: X" on another.
- Pinned failure text is clipped at capture, so the per-line detail held in
  `.testbench/run-state.json` and re-posted on every snapshot stays bounded
  no matter how long a Playwright call log runs.
- **Test Explorer anchors an in-skill failure at the skill file.** A run that
  descends into a `[skill: ...]` reports its body steps with lines in the
  skill's file, but every failure was anchored on the test file's URI — so
  clicking the failure jumped to that line number in the test, which could be
  prose, an unrelated step, or past the end of a shorter file. The streamed
  output names the file too (`✗ step on line 7 of login.md failed — …`),
  since Test Explorer shows no gutter to disambiguate a bare line number.
  `FrameInfo.uri`'s doc comment claimed "file:// URI form"; it has always
  been a plain absolute filesystem path, and now says so.

### Added — TestBench: parameter completion inside a skill call

With the cursor in the argument position of a skill call — `1. [skill
login │` — the dropdown now lists that skill's declared parameters, read
from its own `## Parameters` section, each with the bullet's text as
documentation. Accepting `username` inserts `username="│"` with the
caret between the quotes (Tab jumps past them), parameters the call
already passes drop out of the list — on either side of the cursor — and
the skill's outputs ride along as `out.<name>` items. Inside the quotes
the existing `{{` and `${` completions take over, so
`username="{{username}}"` composes out of three completions without
hand-typing a name. Value positions (inside quotes, arrays, after `=`)
stay quiet.

### Added — TestBench: skill-name completion inside `[skill …`

Typing `[skill ` (or `[skill: `) in a step now completes the skill
*names* right there — every skill under the project's `skills/`
directory, subfolder skills path-qualified (`auth/login`) — replacing
exactly what you've typed, so `1. Log in [skill: au` accepts to
`1. Log in [skill: auth/login`. The list keeps completing across `/`
for subfolder names, stays quiet inside bracketed prose (`[skillful]`)
and after a closed call, and the existing whole-call snippets offered
after a step number now replace the typed token — accepting at
`1. [sk` no longer pastes a second bracket.

### Changed — the colon in `[skill: ...]` / `[tool: ...]` is now optional

`[skill login]` is the same call as `[skill: login]`, and `[tool seed_cart
items=2]` the same as `[tool: seed_cart items=2]` — every arg form, output
alias, path-qualified name, and prose label works identically under both
spellings. This applies to `[skill:` and `[tool:` only; `[input:`,
`[output:]` and `[interactive]` still require their colon.

Bracketed prose is left alone: the keyword must be followed by the colon
or whitespace (so `[skills]` and `[skillful]` are prose), a markdown link
such as `[skill guide](./guide.md)` is never an invocation, and a
colon-less token that doesn't parse is treated as prose rather than
erroring — `Verify the [skill level: expert] badge` is a sentence, and
failing it would have failed the whole file. The explicit `[skill: ...]`
spelling keeps the strict reading: a malformed one is still a parse error
pointing at the problem.

Everything that keys off the token moved with it. The MCP errand/prose
scan and code-behind's never-generate rule now call the parser instead of
matching a look-alike regex, so they cannot disagree with the runner about
what a call is; TestBench's F12 targets, tool-line detection and
root-frame step filter share one matcher.

### Added — TestBench: Renumber Steps

Right-click the line-number gutter in a test file and pick **TestBench:
Renumber Steps** to fix the ordinals after inserting a step in the middle.
With step lines selected, only those are renumbered, each continuing from the
step above it; with nothing selected, the whole file goes sequential — the
main flow 1..N, every `### Section` body restarting at 1. Only the leading
digits change, so the instruction text, its spacing, and any code-behind
binding are byte-identical afterwards. What counts as a step is runner-core's
classifier, so numbered items that never run — those under a `####` heading,
inside a ``` fence, or outside the `## Steps` span — are left alone rather
than being claimed as steps; fenced example lines don't shift real steps'
numbers either. A selection that ends at column 0 of a line (the shape
gutter drags, Shift+Down and Ctrl+L produce) doesn't renumber that trailing
line — only what you visibly selected changes.

### Added — per-test viewport

A test file can now declare the page size it runs at:

```markdown
## Config
- viewport: mobile
```

`mobile` (390×844), `tablet` (768×1024), `desktop` (1440×900), or an explicit
`<width>x<height>` such as `390x844`. The size applies to that test only —
other tests on the same server keep the default — and it is exact in both
headed and headless modes, unlike `browser.viewport`, which headed runs
ignore. Aimed at sites that branch on CSS breakpoints; it is not device
emulation (no touch, mobile user agent, or devicePixelRatio change).

TestBench restarts the browser session automatically when the value changes
between runs, so an edited size takes effect on the next Run. Combining
`viewport:` with `cdp:` is refused — a viewport cannot be imposed on an
attached browser. A whole project can be pinned with `browser.fixedViewport`
in `aiui.config.json`; a test's own key overrides it. See
stories/per-test-viewport.md.

### Added — inline sections

A `### Name` heading inside `## Steps` now defines a named block of steps,
invoked by writing the bare name as a whole step:

```markdown
## Steps
1. Login
2. Buy something

### Login
1. Go to the login page
2. Type "{{username}}"
3. Click Sign in
```

A section is a macro, not a function: it shares the scope of whatever defines
it, declares no parameters or outputs, and expands inline at parse time — the
runner sees a flat step list, exactly as it does for skills. Sections may
invoke other sections and skills; skill files may define and invoke their own.
Reports badge section-expanded steps with a `section:` chip, alongside the
skill chip rather than instead of it.

Matching is on the raw text as authored, case-insensitively: `1. **Login**`
does *not* invoke `### Login`, and neither does `Login.`. Names that are
reserved H2 keywords, begin with `[`, contain `{{`, are empty, or duplicate an
earlier name are refused at parse time. A section that is never invoked
produces a warning — the tripwire for a call site left behind by a rename.

Sections work everywhere a test runs:

- **CLI** (`aiui run`) — expands and reports them, badging section-expanded
  steps with a `section:` chip alongside the skill chip.
- **Server** — expands sectioned files sent by TestBench over HTTP, with
  section frames, breakpoints on body lines, and re-run anchoring.
- **TestBench (Native)** — full debug parity: gutter status on body lines,
  breakpoints inside a body, step-into a section, a call stack that names it,
  and re-run-with-variables. Plus authoring affordances: go-to-definition and
  document links between a call and its `### Name` heading, section-name
  completion after a step number, and diagnostics for duplicates, dead
  sections, and near-miss typos ("Did you mean section X?").
- **TestBench (Monaco)**, the legacy variant, has no sections support and
  **refuses** to run a sectioned file (error `TB026`) rather than mis-run it —
  use TestBench (Native) or the CLI.

Documented in [SPEC.md](docs/specs/SPEC.md#inline-sections) and the README; a runnable
example ships in new projects at `tests/sections-demo.md` (`aiui init`).

### Changed — `[no-hooks]` on a skill invocation now covers the whole body

`parseTestFile` padded the `skipHooks` array to the expanded step count
instead of remapping it through expansion origins, so `[no-hooks] [skill:
multi_step]` applied to roughly the first expanded step and left the rest
hook-wrapped. It now covers every step the invocation expands to — the
behaviour the hooks story always described. Sections made this the common case
rather than an edge one.

### Changed — expansion now runs for files that define sections

`parseTestFile` expanded only when `skillsDir` was set. It now also expands
when the file defines sections, so a project with no skills directory still
resolves bare-name calls. Consequence for direct `parseTestFile` consumers: in
a **sectioned** file parsed without `skillsDir`, a `[skill: ...]` step that
previously shipped to the AI as raw text now raises a clear error naming the
missing configuration. Sectionless files without `skillsDir` are unchanged,
and the CLI always passes its `./skills` default.

### Fixed — skill frame ids and internal variable namespaces could collide

`expandSkills` minted duplicate instance ids whenever a **nested** skill call
was followed by a **sibling** call at the same level (e.g. a test invoking
`[skill: outer]`, whose body invokes `[skill: inner]`, then invoking
`[skill: sibling]`). The recursion passes nested levels a spread copy of its
context, and the `seq` counter was a bare `number` — copied by value — so
increments inside a nested body never reached the parent, and the next sibling
re-minted an id the nested frame already held.

Two things went wrong as a result:

- **Frames were overwritten.** The nested skill's frame was replaced in the
  shared map by the sibling's, so its steps reported an unrelated skill —
  wrong `sourceSkill` chip in reports, wrong rows in TestBench's call stack,
  and colliding per-step cache keys (`frameScopedStepKey`).
- **Skill isolation broke.** The same id drives the `__skill<N>_` prefix used
  to namespace a skill's internal variables, so two unrelated instances shared
  one namespace and a `[store as:]` in one clobbered the other's value in
  session scope.

The counter is now boxed so every recursion level shares it, matching how the
`frames` map was already shared. Regression coverage in
`tests/skill-expander-frame-id-uniqueness.test.ts`.

Instance numbering changes for tests that nest skills, so `__skill<N>_` names
differ from before. These are internal, per-run names that never appear in
test files or reports — but a snapshot asserting on the literal text will need
updating.

### Breaking — config is now JSON-only (`aiui.config.json`)

`aiui.config.json` is now the **only** config format the framework reads. All
TypeScript/JavaScript config support — `aiui.config.ts`, `aiui.config.js`,
`aiui.config.mjs`, the legacy `ai-ui-auto.config.*` names — and the
`defineConfig` helper have been **removed**. Both consumers (the CLI/server
loader and TestBench-native) now read the same file via `JSON.parse`.

A project that still ships only an `aiui.config.ts` is treated as
**unconfigured**: the CLI silently falls back to defaults and TestBench reports
"no config found" (no skills/tools, F12 warns). There is no shim or
auto-migration.

**Migration — one step.** Rename your config to `aiui.config.json` and reshape
the exported object to a plain JSON object: drop the `import { defineConfig }`
line and the `export default defineConfig(...)` wrapper, quote every key,
replace numeric separators (`1_000_000` → `1000000`), and remove any
`process.env.*` references — secrets such as `AI_API_KEY` belong in `.env` and
are injected at load time, never in the committed config.

While reshaping, **nest `skillsDir` / `toolsDir` under `tests`** — the
canonical location is `tests.skillsDir` / `tests.toolsDir`. Older configs (and
some older docs) placed these at the top level or under a `tools` key; those
are no longer recognized.

| Before (`aiui.config.ts`)                                  | After (`aiui.config.json`)                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `import { defineConfig } from 'ai-ui-automation';`         | _(removed)_                                                 |
| `export default defineConfig({ ... });`                    | `{ ... }`                                                   |
| `skillsDir: './skills'` / top-level or under `tools`       | `"tests": { "skillsDir": "./skills" }`                      |
| `toolsDir: './tools/src'` / `tools.dir`                    | `"tests": { "toolsDir": "./tools/src" }`                    |
| `maxInputTokens: 1_000_000`                                | `"maxInputTokens": 1000000`                                 |
| `apiKey: process.env.AI_API_KEY`                           | _(removed — set `AI_API_KEY` in `.env`)_                    |

Example:

```json
{
  "ai": { "gatewayUrl": "https://aiapi.example.com", "model": "gpt-5.4-mini" },
  "browser": { "headed": true },
  "tests": {
    "dir": "./tests",
    "contextDir": "./context",
    "skillsDir": "./skills",
    "toolsDir": "./tools/src"
  },
  "reports": { "outputDir": "./reports" }
}
```

Two behavior notes:

- **Deep merge of nested objects.** Config now merges over the defaults with a
  recursive deep merge, so a partial nested object inherits its sibling
  defaults — `"browser": { "viewport": { "width": 800 } }` now keeps the
  default `height` instead of dropping it. Arrays still replace wholesale.
- **Editor autocomplete + validation.** The TestBench VS Code extension ships
  the JSON schema and binds it to `aiui.config.json`, so editing the file in
  VS Code gives autocomplete, enum-checking, and hover docs with no setup.
  Outside the extension, add an optional top-level `"$schema"` key pointing at
  `./node_modules/ai-ui-automation/schema/aiui.config.schema.json`. The loader
  strips `"$schema"` before merging, so it never affects the resolved config.
  Malformed JSON is now a hard error (fails loudly with the file path); a
  *missing* file still falls back to defaults silently.

### Breaking — `BrowserConfig` shape

The seven DOM-snapshot noise-reduction toggles have been grouped under a new
`browser.domNoiseReduction` sub-object instead of living flat on
`BrowserConfig`. This consolidates a related family of flags and leaves room
for further reductions to land alongside them.

**Migration.** If your project's `defineConfig({ browser: { ... } })` was
setting any of the flags below, move them inside a `domNoiseReduction: { ... }`
block:

| Before                                          | After                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `browser.collapseRepetitiveDom`                 | `browser.domNoiseReduction.collapseRepetitiveDom`                  |
| `browser.compactSvg`                            | `browser.domNoiseReduction.compactSvg`                             |
| `browser.hideHiddenInputs`                      | `browser.domNoiseReduction.hideHiddenInputs`                       |
| `browser.hideDisplayNoneElements`               | `browser.domNoiseReduction.hideDisplayNoneElements`                |
| `browser.hideAriaHiddenElements`                | `browser.domNoiseReduction.hideAriaHiddenElements`                 |
| `browser.useDomAttributeAllowlist`              | `browser.domNoiseReduction.useDomAttributeAllowlist`               |
| `browser.dropUnstableIds`                       | `browser.domNoiseReduction.dropUnstableIds`                        |

`browser.maxIframeDepth`, `browser.domSnapshotCharLimit`, and
`browser.captureScreenshotsPerAction` stay flat — they're hard caps / capture
controls rather than noise filters.

The programmatic `CaptureDomOptions` shape passed to `captureDomSnapshot()`
is unchanged: it still accepts the flags flat. Only the user-facing
`BrowserConfig` shape changed.

TypeScript will flag any missed migration as a type error on the old field
names.

### Added

- `browser.domNoiseReduction.useDomAttributeAllowlist` (default `true`):
  emit only a curated set of DOM attributes (`id`, `data-testid`, `name`,
  `type`, `role`, `aria-*`, `alt`, `label`, `placeholder`, `href`, `src`,
  `value`, `checked`, `selected`, `disabled`, `readonly`, `for`, `action`,
  `method`, `title`) — drops framework noise like `data-react-*`,
  `data-emotion`, `data-v-*`, long Tailwind/Bootstrap class strings, verbose
  inline `style`. Significant token reduction on framework-heavy pages.
- `browser.domNoiseReduction.dropUnstableIds` (default `false`, opt-in):
  strip `id` attributes matching React 18 useId, Radix UI, Headless UI, MUI,
  and React server-streaming patterns so the AI can't propose a selector
  that won't survive the next render. Element is still emitted; only the
  unstable `id` attribute is removed.
- `browser.captureScreenshotsPerAction` (default `false`): gate screenshot
  capture across the per-turn / post-action / polling-loop / end-of-step
  sites. On-failure and diagnose captures are unaffected. Per-site precise
  gating: pre-turn and polling-loop sites OR-couple with `ai.sendScreenshots`
  since the AI consumes those frames; the post-action site gates only on
  this flag (it's report-only).
- `browser.maxIframeDepth` (default `5`): previously hard-coded to `3`.
- `browser.domSnapshotCharLimit` (default `300_000`): previously hard-coded
  to `100_000`.
- `browser.domNoiseReduction.hideHiddenInputs` (default `true`): drop
  `<input type="hidden">` elements.
- `browser.domNoiseReduction.hideDisplayNoneElements` (default `true`): drop
  elements (and subtrees) whose computed `display` is `none`. Uses
  `getComputedStyle` so class-based hiding is caught, not just inline style.
- `browser.domNoiseReduction.hideAriaHiddenElements` (default `true`): drop
  elements (and subtrees) marked `aria-hidden="true"`.
- Hidden elements are emitted as a tag-only placeholder
  (`<div><!-- hidden: display:none --></div>`) so DOM structure (and
  `nth-of-type` / `nth-child` positions) remains intact for selector
  generation.
- HTML report renders a placeholder for missing per-action screenshots
  naming `browser.captureScreenshotsPerAction` so users know which flag
  controls it.
- `expandDomSubtree` now walks all `aria-*` and all `data-*` attributes (in
  addition to the curated list) for full fidelity in the targeted view.
- New test-app fixture page `/dom-noise` (`fixtures/test-app/dom-noise.html`)
  exercising every DOM-cleaner flag in one place: hidden-input,
  `display:none`, `aria-hidden`, framework attribute noise, the five
  unstable-id patterns alongside stable IDs, a 60-row table for collapse,
  and a decorative SVG for compaction.

### Changed

- The curated DOM-attribute list is now a single shared
  `ALLOWED_DOM_ATTRIBUTES` constant in `src/browser/dom-cleaner.ts` reused
  by both `captureDomSnapshot` and `expandDomSubtree` so the two paths
  can't drift.
- `expandDomSubtree`'s curated list now includes `alt` and `label` in
  addition to the existing primitives.
- `ai.sendScreenshots` default flipped to `false` in `DEFAULT_CONFIG` to
  match the lower-cost default profile.

### Fixed

- Hard timeouts on page/frame `evaluate` so a stuck-JS page can't hang the
  whole runner during DOM capture.
