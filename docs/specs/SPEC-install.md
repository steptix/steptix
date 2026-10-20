# Installing Steptix: one install for VS Code and the terminal

**Status:** spec, for build.
**Opened:** 2026-10-17
**Scope:** Windows x64 first, then macOS and Linux (§3.2). Replaces the
Windows-only runtime installer in `packaging/runtime/` (§10).

## 1. What this is

Steptix has three parts a user wants: the VS Code extension, the `steptix`
command for the terminal, and the server both of them talk to. Today the
extension is installed by hand from a `.vsix` file, and the server and command
come from a Windows-only installer that also needs Node.js installed first.

This spec replaces that with two ways in, which end in the same place:

- **From a terminal:** `npm i -g steptix`.
- **From VS Code:** install Steptix from the Extensions Marketplace.

A third way, a single downloaded file, serves machines with no internet access
(§5.6).

Whichever way someone starts, they get the server, the extension (if they
use VS Code) and the `steptix` command, all running versions that belong
together. Nothing
is downloaded twice, and nobody has to read instructions to get from "I
installed it" to "my first test runs".

The goal is that it is seamless. Every scenario below is judged by one test:
did the user have to do anything they would not have guessed?

## 2. Words used in this spec

| Word | Meaning |
| --- | --- |
| **Server** | The part of Steptix that runs tests. The extension and the `steptix` command both use it. It is the large part: it drives the browser, talks to the AI and writes the reports. |
| **Launcher** | The first thing the `steptix` command does. It picks which server version on this machine to use and hands the command to it. It is part of the same package as the server (§3.1). |
| **Steptix folder** | One folder per user where Steptix keeps its files: `%LOCALAPPDATA%\steptix` on Windows, `~/.steptix` on macOS and Linux (or `$XDG_CONFIG_HOME/steptix` when that is set). It already holds the machine key today. |
| **Node.js** | The program that runs JavaScript outside a browser. The server needs version 22.21 or later. |
| **npm** | The tool that comes with Node.js for downloading and installing JavaScript packages. |
| **PATH** | The list of folders a terminal searches when you type a command. A command works in a terminal only if its folder is on PATH. |
| **Offline file** | One file per platform that holds the launcher, the server and everything they need, for machines with no internet access (§5.6). |

## 3. What gets published, and where it goes

### 3.1 What is published

| What | Where | Notes |
| --- | --- | --- |
| `steptix` | npm | One package: the server, the `steptix` command with its launcher, and the `steptix/tools` and `steptix/codebehind` modules that test projects import (§3.4). |
| Extension `steptix.steptix-vscode` | VS Code Marketplace, and as a `.vsix` file on GitHub Releases | Published by the `steptix` publisher. |
| Offline files `steptix-<version>-<platform>.tgz` | GitHub Releases | One per supported platform (§5.6). |

The extension and the `steptix` package share the first two numbers of their
version; the last number is each one's own (§4.2). The first release is 1.0.0
for both (§10).

Version numbers are plain `major.minor.patch`, because the Marketplace accepts
nothing else (no `-beta` or `-dev` suffix).

**For now, every release is a preview.** It goes out on the normal channels:
the Marketplace's ordinary release, and npm's `latest` tag, so `npm i -g
steptix` and the Install button work as every scenario below describes. The
extension's `package.json` carries `"preview": true`, which puts a
**Preview** label on its Marketplace page. When Steptix is ready for a stable
release, the label comes off and a separate pre-release channel may start
(§11).

Not published: the Electron desktop app, and the Flick extension
(`flick-vscode`), which is being retired.

### 3.2 Platforms, in order

1. **Windows x64.** The first release.
2. **macOS on Intel, macOS on Apple Silicon, and Linux x64.** Next.
3. **Windows on ARM and Linux on ARM.** Later.

A platform is supported once its packages pass the release test (§10.1) on
that platform. Until then, the extension on an unsupported platform says so
plainly instead of trying an install that cannot work (§8.4).

**This is a deliberate exception to CLAUDE.md's rule** that what works on one
platform needs a counterpart on the others. The exception covers releasing
and release testing only, not the code:

- Everything this spec adds is written for all three operating systems from
  the start: folders, PATH, the launcher, the extension's install. Nothing
  Windows-only goes in on the grounds that Windows ships first.
- The four unit suites keep passing on Windows, macOS and Linux, as CLAUDE.md
  requires, including the tests for this spec's code.
- What waits is publishing a platform's packages and running the release test
  there. When a platform's turn comes, that is the only work left.

### 3.3 Inside the Steptix folder

```
<Steptix folder>/
  runtimes/
    1.3.0/          one folder per version, each holding the whole steptix
    1.4.0/          package (§4.3 says which versions are kept)
  node/
    22.21.0/        Steptix's own copy of Node.js, only if it had to download one (§4.6)
  bin/
    steptix         a small script the extension sets up (§5.5), only if needed:
                    it starts the launcher in the newest runtimes/ folder
  .env              the machine key and server address, as today
```

`runtimes/` is the folder the extension already looks in today, so it keeps
its name.

### 3.4 One package, because test projects import it by name

Test projects import from Steptix by the package name `steptix`:

- A user's own tools start with `import { defineTool } from 'steptix/tools'`.
- Every code-behind file Steptix generates starts with `import { defineSteps }
  from 'steptix/codebehind'` (`src/codebehind/writer.ts`).

A project with no copy of Steptix of its own needs none: the server answers
those imports with itself (`src/tools/reload.ts`). A project that installs
`steptix` locally, for example so the editor can check its tools' types, gets
the same package everything else uses.

Splitting the server into a package with another name would break both: the
server would no longer answer to `steptix`, and a local `npm i steptix` would
bring the launcher without the modules. So Steptix stays one package, and the
launcher is just the first thing its `steptix` command does. Nothing in this
spec changes how these imports resolve.

## 4. Rules every scenario follows

The scenarios in §5 to §9 refer back to these by number.

### 4.1 One place for servers, one folder per version

Every server on the machine lives in `<Steptix folder>/runtimes/<version>/`.
The extension and the launcher look there and nowhere else when choosing what
to run. A folder is copied in under a temporary name and renamed when it is
complete, so a half-finished copy is never picked up.

### 4.2 Versions share major.minor; the newest matching server runs

A version has three numbers, `major.minor.patch`. The extension and the
`steptix` package share the first two. The last is each one's own:

| | Version |
| --- | --- |
| `steptix` package (server and command) | 1.4.3 |
| VS Code extension | 1.4.1 |

- **A new feature, or anything that changes how the extension and the server
  work together, is a new minor for both,** released together: 1.4.x to
  1.5.0.
- **A fix to one of them is a new patch of that one alone,** released alone:
  server 1.4.3 while the extension stays at 1.4.1.
- **Each extension and launcher states the server it needs:** the same
  major.minor, and at least a given patch, normally `.0`. It asks for a
  higher patch only when a fix of its own relies on a fix in the server. The
  launcher needs its own major.minor.

Which server runs:

- **Normally, the newest matching one** in `runtimes/`: the newest with the
  right major.minor and at least the needed patch. The extension and the
  launcher choose the same way, so when they share a major.minor the terminal
  and VS Code run the same server.
- **Never one that does not match.** Extension 1.4.1 runs neither server
  1.3.x nor 1.5.x; it installs the newest 1.4.x (§6.2).
- **Unless the user chose one** with `steptix server use <version>` (§6.5).

Which server the extension installs: the newest published patch of its
major.minor (npm's `steptix@1.4`), not a number fixed inside the extension.
So a server fix reaches VS Code users without a new extension release (§6.2).

Within one major.minor, a newer server patch keeps working with every
extension patch of that minor, because a patch never changes how the two work
together. The release test checks that (§10.1).

A plugin for another editor, such as a future JetBrains one, follows the same
rule (§12).

### 4.3 A running server is never changed; the previous version is kept

Updating never writes into a server's folder. A new version goes into a new
folder beside it. The running server carries on until it stops, and the next
start uses the new one.

Steptix keeps these and removes the rest:

- for each major.minor that an installed extension or launcher needs, the
  newest server of it,
- the version before the newest, so going back needs no download (§6.5),
- one the user chose with `steptix server use`, if any.

Each extension and launcher writes its own version into the Steptix folder
when it starts, so the clean-up knows which major.minor versions are still
needed.

A version is removed only when nothing is running from it. If something is,
it is removed the next time Steptix checks.

### 4.4 Nothing is downloaded twice

Before downloading a server, the extension checks whether one is already on
the machine: first in `runtimes/`, then in npm's own install of `steptix`
(§5.3). It downloads only when neither has the version it needs.

### 4.5 Ask before downloading, never after the user already chose

- **In VS Code**, installing the extension is not a request to download a
  server. The extension asks first, and says how big the download is. It asks
  **once**, right after the extension is installed (§5.2). After Not now it
  never asks again on its own, not after a restart and not in another window.
  It asks again only when a Run needs the server.
- **Updates do not ask.** Once a server is on the machine, by any route, the
  user has said yes to having one. When the extension updates and needs a
  newer server, it fetches that server by itself (§6.2). The only question
  left is the first install.
- **In a terminal**, `npm i -g steptix` already was the request. Nothing asks
  again.

### 4.6 Which Node.js runs the server

The user's own Node.js comes first. Steptix installs one only when the user
has none that is new enough. The order is checked every time a server starts,
not only at install:

1. **The user's own `node`** (the one on PATH), if it is 22.21 or later.
2. **Steptix's own copy** in `<Steptix folder>/node/`, if an earlier install
   downloaded one.
3. **Otherwise, Steptix installs one.** The extension downloads Node.js from
   nodejs.org into `<Steptix folder>/node/`, as part of the server install
   it already asked about (§4.5). It checks the download against the
   fingerprints nodejs.org publishes for each file, and refuses one that does
   not match. The launcher cannot do this, because it is itself running on
   Node.js; it says which version is needed instead (§5.1).

Steptix's own copy is only ever a fallback. It never goes on the user's PATH
and never replaces their Node.js for anything else. If they later install a
new enough Node.js themselves, Steptix uses theirs from the next start, and
its own copy stays unused until **Steptix: Uninstall Server** removes it
(§9.2).

Any Node.js of the right version can run any server folder, whichever Node.js
installed it.

### 4.7 One install at a time

Two VS Code windows, or a window and a terminal, can both notice that no
server is installed. Only one installs. The other waits for it, then uses the
result. The same holds for removing old versions.

### 4.8 Always say what is running

- `steptix --version` prints the launcher's version, the server version it
  will run, the folder it runs it from, and whether the user chose that
  version.
- The extension shows the server version and where it came from (npm, the
  extension, or an offline file) in its status and in the Output panel.

### 4.9 Never change the user's own npm install

The extension never runs `npm i -g` or `npm rm -g`. That install belongs to
the user, it may need `sudo` on macOS and Linux, and they may have chosen its
version on purpose. The extension installs into the Steptix folder instead.

### 4.10 Every failure says what to do next

No message ends at "failed". Each one names what went wrong, in the user's
terms, and the step that fixes it, with a button where one fits.

### 4.11 npm settings are respected

Downloads of the server go through npm, even when the extension starts them.
npm reads the user's own settings file (`~/.npmrc`), so a company's own
package registry and proxy are used without any Steptix setting.

### 4.12 Developer settings keep working

Two existing User settings let someone working on Steptix itself run a server
from their own checkout. They keep their meaning, and they switch this spec's
behaviour off rather than fighting it:

- **`steptix.serverAutoStart.command` is set:** the extension starts that
  command when no server is running, exactly as today. It never offers to
  install or update a server, and it does not apply the version checks in
  §4.2 and §6.4 to whatever server answers. The person who set the command
  chose that server.
- **`steptix.serverAutoStart.useInstalledRuntime` is off:** the extension
  never installs, updates or starts a server from `runtimes/`, and never asks
  about one. With no server running, it says so, as today.

The live test runner and an Extension Development Host start their own
servers from the checkout. A checkout's server and extension share
major.minor (§4.2), so the version checks pass without either setting.

### 4.13 Files say which version wrote them

Two Steptix versions can work on the same project. `steptix run` in a
terminal runs the tests in its own process (`src/cli/commands/run.ts`), not
through VS Code's server, so when the terminal's major.minor differs from the
extension's (§4.2), both read and write the same files.

So every file Steptix writes in a project to read back later records the
Steptix version that wrote it. Compiled step files and their cache are the
first; the change that adds the stamp lists the rest. Reports are for people,
not for Steptix to read back, so they need none.

When Steptix reads such a file:

- **Written by the same or an older major.minor:** it reads it as today.
  Newer versions keep reading what older ones wrote.
- **Written by a newer major.minor:** it ignores the file, never rewrites
  it, carries on, and says so. A version difference does not make a test
  wrong, so it does not fail one:
  - **Compiled steps** are a speed-up, not the test. The steps run with the
    AI instead, exactly as steps that were never compiled do, so the result
    means the same. The file is left as it is, so the newer version still has
    its compiled steps.
  - **The output and the report say what happened:** *"3 steps were compiled
    by Steptix 1.5 and ran with the AI instead. Update with npm i -g steptix
    to use them."* (or *"Update the Steptix extension"* in VS Code).
  - **Only when there is nothing to fall back on**, such as a run with no AI
    chosen, does the step fail, as any uncompiled step without an AI does
    today. That message names the update too.
  - **Other stamped files** follow the same rule: ignored, never rewritten,
    and a warning.

Patches never change these files' format (§4.2), so the check compares
major.minor only.

## 5. Installing

### 5.1 Scenario 1: from a terminal only

**Before:** the user has Node.js 22.21 or later and npm. They are using npm,
so they have it.

1. **They run `npm i -g steptix`.** npm downloads the whole package, with its
   normal progress display. `steptix` now works in every new terminal,
   because npm's folder is already on PATH.
2. **They run their first `steptix` command,** any command. The launcher sees
   that its own version is not in `runtimes/` yet. It prints one line,
   *"Setting up Steptix 1.4.0 (first run only)…"*, copies its package from
   npm's folder into `runtimes/1.4.0/`, and then runs the command they typed
   from there. This takes a few seconds and needs no network.
3. **First-run setup** (§7.5) checks for a browser and whether an AI is
   chosen, and points to `steptix ai` if not.

**If their Node.js is too old:** npm warns during the install, and the
launcher refuses to run with *"Steptix needs Node.js 22.21 or later. You have
20.11. Install a newer Node.js from nodejs.org and run this again."*

**If they installed with `sudo`** (macOS and Linux): npm's copy is owned by
the administrator, but the first-run copy is made by the user into their own
Steptix folder, so it is theirs. Nothing later needs `sudo`.

### 5.2 Scenario 2: from the Marketplace only

**Before:** VS Code. Node.js is optional.

1. **They install Steptix from the Extensions view.** The extension starts
   straight away, whatever folder is open, and opens the welcome page (§7.1).
2. **The extension looks for a server** (§4.4). It finds none.
3. **It asks, once,** in a notification:

   > *Steptix needs its local server to run tests. About N MB to download.*
   > **[Install]** **[Install and add steptix to PATH]** **[Not now]**

   - **Install** installs the server. `steptix` then works in VS Code's own
     terminals and nowhere else, so nothing changes outside VS Code (§5.5).
   - **Install and add steptix to PATH** does the same and also makes
     `steptix` work in every terminal (§5.5).
   - **Not now** does nothing. VS Code remembers the answer for the user, not
     for the window or the folder, so the question does not come back after a
     restart or in another window. The next time a Run needs the server, the
     same three answers appear again, with **Cancel** in place of Not now.
   - The welcome page's server step offers the same choice: an **Install
     server** button and an *Also add steptix to PATH, for every terminal*
     checkbox.
   - If `steptix` is already on PATH (scenarios 3 and 4), the PATH answer and
     the checkbox do not appear.

   Asking right after the install, rather than on the first Run, means the
   server is usually ready by the time the user has a test to run.
4. **On Install**, with progress shown in the notification, on the welcome
   page and in the Output panel:
   1. If no suitable Node.js is available (§4.6), it downloads its own copy
      into `<Steptix folder>/node/`.
   2. With that Node.js's npm, it installs the newest `steptix` package
      matching the extension (§4.2) into `runtimes/<version>/`.
   3. The welcome page says *"You can carry on with the steps below while
      this finishes"*, so the user chooses the AI meanwhile (§7.2).
5. **The server starts** on the first Run, as it does today.

If they press Run while the download is still going, the Run waits for it
rather than failing.

### 5.3 Scenario 3: installed from a terminal, never run, then the Marketplace

The user ran `npm i -g steptix` but never ran a `steptix` command, then
installed the extension. The server is on the machine, in npm's folder, but it
was never copied into `runtimes/`, because that happens on the first command.

1. **They install the extension.**
2. **The extension looks in `runtimes/`.** It is empty.
3. **It looks for `steptix` on PATH** and finds the one npm installed.
   It runs `steptix server install`, which does exactly what the first
   terminal command would have done: copy the package from npm's folder into
   `runtimes/<version>/`. It reports the folder and version back.
4. **If that version matches the extension** (§4.2), the extension uses it
   without asking anything, and says *"Using Steptix 1.4.0 installed with
   npm"*.
5. **If it does not match**, for example npm's is 1.3.x and the extension
   1.4.x, the extension installs the newest 1.4.x without asking, as any
   server update does (§6.2), showing *"Updating the Steptix server to
   1.4.0…"*. It installs into the Steptix folder as in §5.2 step 4, and does
   not update the user's npm install (§4.9). The terminal's `steptix` keeps
   running its own 1.3.x until the user updates it with npm, because each
   runs a server matching itself (§4.2).
6. **The server runs** on the `node` on PATH, which the user already has
   (§4.6). Nothing is downloaded.
7. **The `steptix` command** already works everywhere through npm, so the
   extension sets nothing up and asks nothing about PATH.

**If VS Code cannot see `steptix` on PATH:** VS Code reads the user's shell
settings when it starts, so it normally sees the same PATH as a terminal. If
that fails (a slow or broken shell startup file; VS Code shows its own warning
about it), the extension also asks npm where it installs packages. Only if
both fail does it fall back to §5.2, which downloads a second copy. That is
wasteful but correct: both copies end up in the same `runtimes/` folder.

### 5.4 Scenario 4: installed from a terminal and used, then the Marketplace

The server is already in `runtimes/`, put there by the first `steptix`
command.

1. **They install the extension.**
2. **It finds the server in `runtimes/`.** If it matches the extension
   (§4.2), it uses it, says which version and where from, and asks nothing.
   If it does not, as in §5.3 step 5.
3. **Nothing is downloaded**, and nothing about PATH is asked.

### 5.5 Scenario 5: from the Marketplace, then wanting the `steptix` command

The extension installed the server (§5.2). The user also wants `steptix` in a
terminal.

- **In VS Code's own terminals**, it already works. When the extension
  installs the server, it puts a small `steptix` script in
  `<Steptix folder>/bin/` and adds that folder to the PATH of VS Code's
  terminals only. Nothing outside VS Code changes.
- **For other terminals**, the user chose at install time: the **Install and
  add steptix to PATH** answer, or the checkbox on the welcome page (§5.2).
  There is no separate question about it later. Anyone who wants it afterwards
  uses **Steptix: Add steptix to PATH**, from the Command Palette or the link
  on the welcome page's server step.
  - Windows: it adds the folder to the end of the user's own PATH, leaving
    every other entry as it was.
  - macOS and Linux: it adds a link in `~/.local/bin` if that folder is on
    PATH, otherwise one line to the shell's startup file (`~/.zshrc` or
    `~/.bashrc`).
  - When it is done it says *"steptix is on PATH. Reopen any terminal that is
    already open."*, and on macOS and Linux also what it changed, for example
    *"Added a line to ~/.zshrc."*
  - The script in `bin/` starts the launcher in the newest `runtimes/` folder
    with the Node.js the server uses (§4.6), so it works even for someone who
    never installed Node.js.
- **If `steptix` is already on PATH** (scenarios 3 and 4), the extension
  skips all of this.
- **If they later run `npm i -g steptix` anyway**, there are two `steptix`
  commands on PATH. Both pick a server the same way (§4.2), so while they
  share a major.minor it makes no difference which one the terminal finds
  first.

### 5.6 Scenario 6: a machine with no internet access

Two kinds of company network look "offline", and they are handled
differently.

**A company that runs its own npm registry** (Artifactory, Nexus and the
like) is not offline for Steptix. Scenarios 1 to 5 work as written, because
npm uses the company's registry (§4.11). If the extension also cannot reach
nodejs.org, the user needs their own Node.js 22.21 or later, which such
companies normally provide (§8.2).

**A machine with no registry at all** installs from files someone carries
across:

**Before:** Node.js 22.21 or later, from the company's IT. Steptix cannot
download it without a network.

1. **Someone downloads two files from the release page on GitHub:** the
   offline file for the machine's platform
   (`steptix-1.4.0-win32-x64.tgz`) and the extension (`steptix-vscode-1.4.0.vsix`).
2. **On the machine, they run `npm i -g ./steptix-1.4.0-win32-x64.tgz`.**
   Everything is inside the file, so npm fetches nothing. `steptix` is on PATH
   as in scenario 1.
3. **The first `steptix` command** copies the package into `runtimes/1.4.0/`,
   as in §5.1 step 2.
4. **In VS Code, they install the `.vsix`** with *Extensions: Install from
   VSIX…*. The extension finds `steptix` on PATH and continues as in §5.3 or
   §5.4. It downloads nothing.
5. **Updating** is the same two files from a newer release.

If the extension tries to download and cannot (§8.1), its message names the
offline files and links to the release page.

The offline file is for one platform only, because a few of the server's parts
are built separately for each operating system. A file for the wrong platform
is refused at install with a message naming the right one.

## 6. Living with it

### 6.1 Updating from a terminal

1. `npm i -g steptix@latest` downloads the new version into npm's folder. Nothing in `runtimes/` changes, so a running server is not affected.
2. The next `steptix` command, or the extension's next Run, whichever comes
   first, copies the new version into its own folder (§4.1).
3. The previous version stays, and anything older is removed once nothing is
   running from it (§4.3).

### 6.2 Updating the extension

1. VS Code updates the extension from the Marketplace, on its own.
2. The new extension needs a server matching it (§4.2). If none is in
   `runtimes/`, it first checks npm's install (§5.3), and otherwise
   **starts fetching it straight away, without asking** (§4.5). It does not
   wait for a Run, so the download is usually finished before one.
3. A notification shows *"Updating the Steptix server to 1.4.0…"* with
   progress, then *"Steptix server 1.4.0 is ready."* The old server keeps
   working until then. If a Run starts before the update is finished, it
   waits for it.
4. Once it is in place, an older server that is still running is replaced
   as §6.4 says: straight away when it is idle, after its test when it is
   busy.
5. The terminal's `steptix` uses it too when it has the same major.minor
   (§4.2).

**A server fix between extension releases** (server 1.4.3 while the
extension stays at 1.4.1) arrives the same way. When VS Code starts, and
once a day after that, the extension asks npm for the newest patch of its
major.minor and fetches a newer one without asking.

Updates still ask in these cases:

- **No server was ever installed** (the user chose Not now): the install
  question of §5.2, as before.
- **The update fails**, for example with no network: the message of §8.1,
  with Retry and Offline install. The old server is not removed.
- **The user chose a version with `steptix server use`**: the new version is
  installed beside it, but the choice stands, and the extension says why it
  will not run it (§6.5).
- **`steptix.serverAutoStart.command` is set, or `useInstalledRuntime` is
  off**: nothing is fetched (§4.12).

### 6.3 Updating while a server is running

Updating never changes a running server's files (§4.3), so it keeps working
and nothing it is doing is cut short.

What happens to it next depends on who needs it:

- **After an update from npm**, the running server may still match the
  extension. Then nothing happens: the server stops when it has been idle
  long enough, and the next start runs the newest matching version.
- **After the extension updates**, the running server may no longer match
  it, and the extension never runs a server that does not match (§4.2). §6.4
  says what the extension does about it.

### 6.4 A running server that does not match

The extension's server keeps running for up to 60 minutes after its last use,
and a user may have started one by hand with `steptix serve`. So right after
the extension updates, the server already running is often an older one. It
can also be one started for another major.minor, for example by a terminal
on a different channel (§11).

Before each Run, the extension asks the running server about itself. The
server already reports its version, its process number and whether a test is
running in it. It also reports **who started it**: VS Code, automatically, or
a person, by hand. That last one is new.

- **It matches the extension** (§4.2): the extension uses it.
- **It does not match, and VS Code started it:**
  - If no test is running in it, the extension stops it and starts the right
    version, showing *"Updating the Steptix server to 1.4.0…"* while it does.
    The Run carries on once the new server is ready.
  - If a test is running in it (another VS Code window still on the old
    extension, for example), the extension waits for that test to finish,
    showing *"Waiting for a test in another window to finish before updating
    the Steptix server"*, then does the same.
- **It does not match, and a person started it:** the extension never stops
  it on its own. It says: *"A Steptix server you started (1.3.0, at
  http://127.0.0.1:3100) does not match this extension (1.4.1). Stop it and
  press Run again, or start a matching one yourself with `steptix serve`.
  [Stop it] [Cancel]"*. **Stop it** stops that server, and only because the
  user asked.
- **It is a version the user chose with `steptix server use`** (§6.5): as
  above, the extension does not run it if it does not match, and says why.

The launcher follows the same rules for a terminal command that needs the
running server.

### 6.5 Going back to an older version

The previous version is still installed (§4.3), so going back needs no
download.

1. **`steptix server use 1.3.0`** makes 1.3.0 the version both the terminal
   and the extension run, from the next start. `steptix server list` shows
   what is installed, which one runs, and where each came from.
2. **The server must still match the extension** (§4.2). If extension
   1.4.0 finds the user chose 1.3.0, it says: *"You chose Steptix
   server 1.3.0, but this extension is 1.4.0. Install extension 1.3.0 to
   match (Extensions view → Steptix → Install Another Version), or go back to
   the newest server. [Use newest] [Show how]"*.
3. **`steptix server use newest`** undoes the choice.

A chosen version is not affected by updates: a newer version can still be
installed beside it, but the chosen one keeps running until the choice is
undone.

### 6.6 Switching Node.js versions

Tools such as nvm keep a separate npm folder for each Node.js version.

- **The terminal:** after switching, `steptix` may be missing, because it was
  installed under the other version. `npm i -g steptix` puts the launcher back.
  The server is still in `runtimes/`, so the first command has nothing to copy.
- **The extension:** uses the newly selected Node.js if it is 22.21 or later.
  If it is older, it uses Steptix's own copy if there is one, and otherwise
  offers to download one (§4.6).

### 6.7 Two VS Code windows at once

Both may notice there is no server. One installs, the other shows *"Waiting
for Steptix to finish installing in another window"* and continues when it is
done (§4.7). Neither asks twice.

### 6.8 The terminal falls behind VS Code

VS Code updates the extension by itself; npm updates the terminal's `steptix`
only when the user asks. So the two can drift onto different major.minor
versions, and then two versions work on the same project (§4.13).

When the extension starts, it looks at npm's install of `steptix` (as in
§5.3). If its major.minor is older than the extension's, the extension says
so once for that version:

> *The steptix command in your terminal is 1.4. VS Code is on 1.5. Update it
> so both work on your projects the same way: npm i -g steptix*
> **[Copy command]** **[Don't show again]**

- **Copy command** puts `npm i -g steptix` on the clipboard. The extension
  never runs it itself (§4.9).
- **Don't show again** stops the notice for good.
- **Only major.minor counts.** A different patch is not mentioned, because
  patches do not change how the two behave (§4.2).
- **The other way round:** if the terminal is on a newer major.minor than the
  extension (VS Code's own updates turned off, for example), it says
  *"The steptix command in your terminal is 1.5, newer than this extension
  (1.4). Update the extension."*
- **No npm install, no notice.** The `steptix` script the extension puts in
  `bin/` (§5.5) always runs a server matching the extension, so it cannot
  fall behind.

## 7. First-run setup

### 7.1 The welcome page

The extension opens it the first time it starts (§5.2), and **Steptix:
Welcome** opens it again at any time. It holds four steps, each showing its
state, and they can be done in any order:

1. **Steptix server:** *Not installed*, *Installing* (with progress, and
   which Node.js it uses), or *Ready* (the version, and whether `steptix` is
   on PATH, with a link to add it).
2. **AI:** which AI Steptix uses (§7.2).
3. **Browser:** whether Google Chrome was found (§7.4).
4. **Your first test:** **Create a sample project** or **Open a folder**
   (§7.3).

None of steps 2 to 4 needs the server, so the user can do them while step 1
downloads. The AI step checks keys and lists models from the extension
itself, Copilot's dialog and models come from VS Code, and saving the choice
is a file write.

The machine key is created the first time the server starts, as today. The
user never sees it.

### 7.2 Choosing the AI

There are two kinds of AI, and the step offers both:

- **GitHub Copilot**, through VS Code. No API key.
- **An AI provider:** OpenAI, Anthropic or OpenRouter, with the user's own
  API key and a choice of model.

**Which one is chosen to begin with.** Steptix recommends **GPT 6 Luna**,
`openai/gpt-6-luna`, which is already its default model.

- **Copilot offers GPT 6 Luna:** Copilot is chosen to begin with, marked
  *Offers GPT 6 Luna*, and the button says **Use Copilot**.
- **Copilot is there but does not offer GPT 6 Luna:** the provider form is
  chosen to begin with. Copilot is still offered, saying *"Your Copilot does
  not offer GPT 6 Luna, the model Steptix recommends. You can still use it
  with one of the models it does offer."*
- **No Copilot:** the provider form on its own.

The model is the test because VS Code does not tell an extension which
Copilot plan the user has: an extension sees only each model's name, id,
vendor, family, version and input limit. A free plan, or a company policy
that leaves the model out, shows up as Copilot not offering GPT 6 Luna, which
is what matters to Steptix anyway. If VS Code lists Copilot's models only
after the user has acted the first time
([copilot-lm-bridge.md](../../stories/copilot-lm-bridge.md), Consent), the
check runs when the user opens the AI step, which shows *"Checking GitHub
Copilot…"* meanwhile.

**Using Copilot.** **Use Copilot** runs the existing setup behind **Steptix:
Use Copilot for AI**:

1. VS Code asks, once, whether Steptix may use Copilot's models: **Allow** or
   **Cancel**. This is VS Code's own dialog.
2. Steptix picks GPT 6 Luna. The model list holds only the models Copilot
   offers.
3. The step explains the cost in one line: *"Uses Copilot requests when
   Steptix works out or repairs a step. A test that has been compiled runs
   without any."*

**Using a provider.**

1. **Choose the provider:** OpenAI, Anthropic or OpenRouter. A link beside
   the key field goes to that provider's page for making a key.
2. **Paste the key and press Check key.** The extension asks the provider
   for the models the key can use. A refusal says so before anything is
   saved: *"Anthropic did not accept this key. Check that you copied all of
   it, or make a new one."* A provider it cannot reach gives the network's
   reason and says a company may need its proxy set for VS Code.
3. **Choose the model.** The list puts Steptix's recommended model first:
   - OpenAI: GPT 6 Luna (`openai/gpt-6-luna`),
   - Anthropic: Claude Sonnet 5.5 (`anthropic/claude-sonnet-5-5`),
   - OpenRouter: GPT 6 Luna, when OpenRouter offers it.

   Then come every model the key can use, then *Type a model id…*. The
   recommended models ship with each release.
4. **Save.** From then on the key is shown only by its last four characters.

**What is saved, and where.** A provider writes `AI_MODEL`, with the
provider's prefix (`openai/…`, `anthropic/…`, `openrouter/…`), and
`AI_API_KEY`. Copilot writes the three lines its setup already writes
(`AI_MODEL=gateway/copilot/…`, `AI_GATEWAY_URL` and the bridge's
`AI_API_KEY`). Beside the Save button it says *"For all your projects.
Change"*:

- **All my projects** (the default) writes `<Steptix folder>/.env`, which
  already gives AI settings to any project that sets none of its own. This
  also works before any folder is open.
- **Only this project** writes the project's `.env`, which wins over the
  all-projects one. It needs an open folder.
- If the project is a git repository and its `.env` is not ignored, Steptix
  says so and offers to add it to `.gitignore` before writing a key there.
- A project `.env` with an empty `AI_API_KEY=` line blocks the all-projects
  key. When the open project has one, the step says so instead of saving a
  choice that would not reach it.

**Changing it later.** A status-bar item shows what is in use, for example
*AI: Copilot · GPT 6 Luna*. Clicking it, or **Steptix: Choose AI**, opens the
AI step again.

**When Copilot stops answering.** When the month's requests are used up, or
the permission was taken back, the step that needed the AI says so with a
**Choose AI** button: *"Copilot has used up this month's requests. Compiled
tests still run. To keep working now, switch to an AI provider."* If Copilot
stops offering GPT 6 Luna, it says *"Your Copilot no longer offers GPT 6 Luna.
Pick another Copilot model, or switch to an AI provider."*

**From a terminal: `steptix ai`.** It asks the same questions: provider, key
(checked the same way), model with the provider's recommended model first,
and where to save. It
writes the same files. Copilot is not offered, because it works only inside
VS Code, and it says so. A terminal command that needs the AI while Copilot
is configured says *"Copilot works only inside VS Code. To use the AI from a
terminal, run steptix ai."* instead of failing to connect.

### 7.3 The first test: a sample project

**Create a sample project** asks where to put it, then creates a folder with:

- `tests/first-test.md`, a short test of four steps,
- `pages/sample-page.html`, the page it tests, inside the project, so it
  works without a network and never changes under the test,
- `steptix.config.json`,
- the test's steps already compiled.

It then opens the folder and the test. Because the steps are compiled, the
first Run makes no AI calls at all: it passes before an AI is chosen, and
costs a Copilot user nothing. The sample is built and compiled for each
release and checked by the release test (§10.1).

**Open a folder** is for people who already have tests.

### 7.4 A browser

Steptix uses Google Chrome by default. If Chrome is not installed, the step
says so and offers **Download a browser for Steptix**, which runs `steptix
browsers`.

Two gaps here are tracked in
[steptix/steptix#109](https://github.com/steptix/steptix/issues/109) and must
be closed before this ships:

- `steptix browsers` exists today only in the Windows installer's launcher,
  which this spec retires, so it has to become a command of the `steptix`
  package.
- Each Playwright version needs its own build of Firefox, WebKit and
  Playwright's Chromium. A server update that moves Playwright (§6.2) must
  fetch the new builds of the browsers the user had downloaded, and a missing
  build must fail with Steptix's own message naming `steptix browsers
  install`, not Playwright's.

### 7.5 From a terminal

The first `steptix` command prints the same checks as lines: whether Google
Chrome was found, and, if no AI is chosen, *"No AI chosen yet. Run steptix ai
to choose one."*

## 8. When things go wrong

### 8.1 No network, or npm's registry is blocked

*"Could not download the Steptix server: <npm's reason>. If your company uses
its own npm registry, check that npm works in a terminal (`npm view
steptix`). Without network access, install from the offline files instead.
[Retry] [Offline install] [Show details]"*. Offline install opens the release
page (§5.6). Nothing half-installed is left behind (§4.1).

### 8.2 nodejs.org is blocked

*"Could not download Node.js. Install Node.js 22.21 or later yourself and
press Retry. [Open nodejs.org] [Retry]"*. Once a suitable `node` is on PATH,
Retry uses it (§4.6).

### 8.3 Install stopped partway

VS Code closed, the machine slept, the disk filled up. The incomplete copy
was never renamed into place (§4.1), so it is ignored and cleaned up on the
next attempt, which starts again.

### 8.4 A platform that is not supported yet

*"Steptix does not run on Linux on ARM yet. Supported now: Windows x64."*,
listing what §3.2 has reached. Nothing is downloaded.

## 9. Uninstalling

Uninstalling never removes test projects, the machine key and its `.env`,
or browsers Steptix downloaded.

### 9.1 Installed from a terminal

1. `steptix uninstall` removes every server in `runtimes/` after asking to
   confirm. If a server is running, it says so and asks the user to stop it
   first (`steptix stop`).
2. `npm rm -g steptix` removes the launcher and npm's copy of the server.

If they skip step 1, the copies in `runtimes/` stay. npm gives a package no
reliable way to clean up after itself, so the npm package's readme says to
run `steptix uninstall` first.

### 9.2 Installed from the Marketplace

Uninstalling the extension from VS Code leaves the server, because VS Code
gives extensions no dependable moment to clean up, and the `steptix` command
may still be in use. To remove everything, run **Steptix: Uninstall Server**
first. It removes:

- every server in `runtimes/`,
- Steptix's own Node.js, if it downloaded one,
- the `steptix` script in `bin/`, and the PATH entry or startup-file line it
  added.

### 9.3 Installed both ways

Either uninstall removes the servers. If npm's `steptix` is still installed
afterwards, its next command copies its package back in (§5.1 step 2),
which is the expected result: the user still has Steptix installed.

## 10. What changes in the repo

- **Changed:** `steptix` stays one npm package (§3.4). Its `steptix` command
  gains the launcher step: pick the version to run (§4.2), copy its own
  package into `runtimes/` on first use (§5.1), and hand the command to that
  folder. The package leaves out what only the Electron desktop app needs
  (Electron, Vite, React, CodeMirror), as the runtime build already does
  (`scripts/build-runtime.mjs`). The desktop app is not shipped at all.
- **New:** the package ships its exact tested dependency versions
  (`npm-shrinkwrap.json`). npm ignores a package's lock file when someone
  installs it, so without this each user would get whatever versions are
  newest that day, not the ones that were tested.
- **New:** the offline files (§5.6). Each is built on its own platform,
  because a few dependencies (desktop automation, and the tool
  Steptix uses to build code-behind files) come as separate builds per operating system.
  npm's `bundleDependencies` setting packs every dependency into the file.
  The normal npm packages do not do this, so online users still get the
  builds for their own machine.
- **New:** launcher commands `server install`, `server list`, `server use`,
  `server remove`, `uninstall`, and the version details in `--version`.
- **Changed:** the extension's server lookup
  (`steptix-vscode/src/extension/server-manager.ts`). Today it gives up when
  no runtime is installed. It will find, install and update servers as above,
  and replace an older running server as §6.4 says.
- **New:** the install question with its three answers, asked once and
  remembered for the user (§5.2), and **Steptix: Add steptix to PATH** (§5.5).
- **New:** the welcome page and **Steptix: Welcome** (§7.1).
- **New:** the AI step (§7.2): the check for GPT 6 Luna among Copilot's
  models, the provider form that asks OpenAI, Anthropic and OpenRouter for
  their model lists, the list of recommended models shipped with each
  release, **Steptix: Choose AI** and the status-bar item. Copilot reuses the
  existing setup (`steptix-vscode/src/extension/lm-bridge-setup.ts`).
- **New:** `steptix ai` for the terminal (§7.2).
- **New:** the sample project, built and compiled for each release (§7.3).
- **New:** the version stamp in every file Steptix writes in a project to
  read back, and setting aside one from a newer major.minor with a warning
  (§4.13).
- **New:** the notice when the terminal's `steptix` is on a different
  major.minor from the extension (§6.8).
- **New:** `steptix browsers` as a command of the package, and keeping
  Playwright's browser builds in step with server updates
  ([#109](https://github.com/steptix/steptix/issues/109), §7.4).
- **Changed:** the server's `/health` answer also says who started it: VS Code
  automatically, or a person by hand (§6.4). It already reports the version,
  the process number and whether a test is running.
- **Changed:** the extension is published to the Marketplace by a new
  `steptix` publisher, so its ID becomes `steptix.steptix-vscode` instead of
  `pkent.steptix-vscode`. VS Code treats that as a different extension: an
  existing `pkent.steptix-vscode` install has to be uninstalled once by hand,
  and the docs and CLAUDE.md that name the old ID change with it. Publishing
  also needs a PNG icon (the Marketplace does not accept SVG for it) and a
  Marketplace description, and `"preview": true` in its `package.json` while
  every release is a preview (§3.1).
- **Changed:** the extension and the `steptix` package share major.minor,
  each with its own patch (§4.2), starting at **1.0.0** for both. Today the
  extension is at 0.5.x and the package at 1.0.0-beta.1; 1.0.0 is newer than
  both, so every existing install sees it as an update. The extension states
  the server patch it needs, and checks npm for newer server patches (§6.2).
  The CLAUDE.md rule that bumps the extension's patch version on every change
  needs replacing to fit (§11).
- **Changed:** CLAUDE.md's platform rule gains a note pointing at the
  Windows-first exception in §3.2, so it is not mistaken for a gap to fix.
- **Retired:** the Windows installer (`packaging/runtime/`,
  `scripts/build-runtime.mjs`, `scripts/verify-runtime.mjs`) and the
  CLAUDE.md section about it, once this ships. Its beta has no installs that
  need supporting, so nothing has to keep recognising it. Its end-to-end
  checks move to the new test below.
- **Release:** npm packages are published from GitHub Actions with npm's
  provenance record, which shows which commit and build produced them. The
  `.vsix` and the offline files go on the same GitHub release.

### 10.1 Every release is tested end to end

The rule for the Windows installer carries over: nothing is published that
was not installed and run the way a user would. On every supported platform
(§3.2), from the exact files about to be published, served by a private test
copy of the npm registry:

| Check | Scenario |
| --- | --- |
| `npm i -g`, first command copies the package, a test runs | §5.1 |
| A test project's own tool (`steptix/tools`) and a generated code-behind file (`steptix/codebehind`) both load against the installed server, with and without a local `steptix` in the project | §3.4 |
| Extension with Node.js 22.21+ on PATH downloads only the server and runs on the user's Node.js | §5.2, §4.6 |
| Extension with no Node.js, or an older one, on PATH downloads Node.js and the server, a test runs | §5.2, §4.6 |
| npm install never run, then the extension: no download, uses npm's copy | §5.3 |
| The install question appears once: Not now, then a restart and a second window, and it does not come back; a Run asks again | §5.2, §4.5 |
| Install and add steptix to PATH: `steptix` runs in a new terminal outside VS Code | §5.2, §5.5 |
| Extension-installed server, `steptix` works in VS Code's terminal | §5.5 |
| The AI step works while the server downloads | §7.1 |
| A stand-in Copilot that offers GPT 6 Luna is chosen to begin with; one that does not, or none, starts on the provider form | §7.2 |
| A wrong key is refused before anything is saved; a good one lists models with the provider's recommended model first | §7.2 |
| Saved for all projects reaches a project with no `.env`; only this project wins over it | §7.2 |
| `steptix ai` writes what the welcome page writes | §7.2 |
| The sample project's first Run passes with no AI chosen and the network off | §7.3 |
| Offline file and `.vsix` installed with the network switched off, a test runs | §5.6 |
| Update from npm while a server runs: the server keeps serving, the next start is the new version | §6.1, §6.3 |
| Extension updates to a new minor: it fetches the matching server without asking, before any Run, and a terminal on the same minor runs it too | §6.2 |
| A new server patch is published with no new extension: the extension fetches it without asking | §6.2 |
| Non-matching server started by VS Code, idle: the extension replaces it and the Run passes | §6.4 |
| Non-matching server started by VS Code, test running: the extension waits, then replaces it | §6.4 |
| Non-matching server started by hand: the extension asks and does not stop it on its own | §6.4 |
| `serverAutoStart.command` set: no install offer, the configured server runs; `useInstalledRuntime` off: no install offer, no start | §4.12 |
| A new server patch runs a test with the oldest and the newest extension patch of its minor | §4.2 |
| An extension never runs a server of another major.minor, newer or older | §4.2 |
| Steps compiled by a newer major.minor: the older `steptix run` runs them with the AI, warns with the update message, and leaves the file unchanged; with no AI chosen, those steps fail with the same message | §4.13 |
| npm's `steptix` on an older major.minor than the extension: the notice appears once, and not for a patch difference | §6.8 |
| `steptix browsers install firefox` from the npm package; a Firefox test still runs after a server update that moves Playwright | §7.4 |
| `server use` the previous version, both sides run it; `server use newest` undoes it | §6.5 |
| Only the newest of each needed major.minor, the previous and a chosen version are kept | §4.3 |
| Two windows install at once: one download, both work | §6.7 |
| Install interrupted, then retried | §8.3 |
| Each uninstall removes what §9 says, and nothing else | §9 |

## 11. Still to settle

1. **Version numbering.** Fixed so far: plain `major.minor.patch`, and every
   release a preview on the normal channels until Steptix goes stable (§3.1).
   Ruled out: date-based numbers such as `2026.10.0`, because they cannot
   carry a pre-release channel.

   **Leading idea for when Steptix goes stable: a stable and a pre-release
   channel.**

   | Channel | Minor number | Marketplace | npm | Who gets it |
   | --- | --- | --- | --- | --- |
   | Stable | even: 1.0.x, 1.2.x | normal release | the `latest` tag | everyone, by default |
   | Pre-release | odd: 1.1.x, 1.3.x | published as a pre-release | the `next` tag | people who chose *Switch to Pre-Release Version* in VS Code, or ran `npm i -g steptix@next` |

   The channel lives in the minor number, which every piece shares (§4.2),
   while patches stay each piece's own:

   | | Stable | Pre-release |
   | --- | --- | --- |
   | `steptix` package | 1.4.3 | 1.5.2 |
   | VS Code extension | 1.4.1 | 1.5.4 |

   A pre-release extension installs the newest server of its own odd minor,
   so a pre-release user gets the matching server without choosing anything
   else. In a terminal, `npm i -g steptix` would stay on stable; only
   `steptix@next` moves to pre-release. The channels never mix: a stable
   client runs only servers of its even minor and a pre-release one only of
   its odd minor. When both run on one machine, they take turns on the one
   port as §6.4 says. A pre-release graduates when its minor moves to the
   next even number for every piece together (1.5.x to 1.6.0).

   Branches would stay simple: `main` is always the next preview, a stable
   release is a tag on `main`, and a short-lived `release/x.y` branch is cut
   from a stable tag only when that stable release needs an urgent fix.

   **When the number changes**, one of:
   - **Every change** raises the patch number of the piece it changed, and
     a release ships whatever `main` has reached (1.0.0, then 1.0.4). This
     is today's rule, extended to the package. Parallel PRs conflict on the
     version lines, and a new minor still needs a deliberate bump of both.
   - **Only at release.** `package.json` holds the next release's number
     and changes only when releasing, where the number is chosen to say
     what the release is. Builds between releases are told apart by the
     commit, shown by the extension (*Steptix 1.0.0 · 3f9a1c2*), which the
     server already reports at `/health`.
   - **The release pipeline picks it.** As the previous option, but pushing a
     tag makes GitHub Actions write the number into the piece being released,
     then build, test and publish it.

   Whichever is chosen replaces CLAUDE.md's "bump the patch version on every
   change" section, which exists so a local install shows a new number.
2. **The terminal's sample project.** `steptix init` should create the same
   sample as **Create a sample project** (§7.3), so both ways in start from
   the same place. What it creates today needs checking first.

The release test cannot sign in to a real Copilot account, so the Copilot
checks in §10.1 use a stand-in language-model provider registered in the test's
VS Code.

## 12. Not in this spec

Each of these is a later change of its own:

- **A plugin for another editor, such as JetBrains.** It shares major.minor
  with the server and keeps its own patch, exactly like the VS Code extension
  (§4.2), so a fix to one editor's plugin never forces a release of the
  other. It uses the same `runtimes/` folder and rules, so a user with both
  editors gets one server. To keep one copy of the install logic, finding,
  installing and updating servers live in the `steptix` command (`steptix
  server install`, `list`, `use`), and each editor adds only a small start:
  find or download Node.js, run `steptix server install`, show progress.

- **Desktop permissions on macOS and Linux.** Desktop automation needs
  Accessibility and Screen Recording permission on macOS, and an X11 session
  on most Linux desktops. First-run setup will check and explain these once
  those platforms are supported.
