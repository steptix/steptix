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
use VS Code) and the `steptix` command, all running the same version. Nothing
is downloaded twice, and nobody has to read instructions to get from "I
installed it" to "my first test runs".

The goal is that it is seamless. Every scenario below is judged by one test:
did the user have to do anything they would not have guessed?

## 2. Words used in this spec

| Word | Meaning |
| --- | --- |
| **Server** | The part of Steptix that runs tests. The extension and the `steptix` command both use it. It is the large part: it drives the browser, talks to the AI and writes the reports. |
| **Launcher** | The small program behind the `steptix` command. It finds the right server on this machine and runs it. It contains no server code itself. |
| **Steptix folder** | One folder per user where Steptix keeps its files: `%LOCALAPPDATA%\steptix` on Windows, `~/.steptix` on macOS and Linux (or `$XDG_CONFIG_HOME/steptix` when that is set). It already holds the machine key today. |
| **Node.js** | The program that runs JavaScript outside a browser. The server needs version 22.21 or later. |
| **npm** | The tool that comes with Node.js for downloading and installing JavaScript packages. |
| **PATH** | The list of folders a terminal searches when you type a command. A command works in a terminal only if its folder is on PATH. |
| **Offline file** | One file per platform that holds the launcher, the server and everything they need, for machines with no internet access (§5.6). |

## 3. What gets published, and where it goes

### 3.1 What is published

| What | Where | Notes |
| --- | --- | --- |
| `steptix` | npm | The launcher. Depends on the server package, so installing it downloads both. Small. |
| Server package | npm | The server. Large. Its name is being settled by the maintainer (§11). This spec calls it `@steptix/server`. |
| Extension `steptix.steptix-vscode` | VS Code Marketplace, and as a `.vsix` file on GitHub Releases | Published by the `steptix` publisher. |
| Offline files `steptix-<version>-<platform>.tgz` | GitHub Releases | One per supported platform (§5.6). |

All of them are released together and carry the same version number (§4.2).

Not published: the Electron desktop app, and the Flick extension
(`flick-vscode`), which is being retired.

### 3.2 Platforms, in order

1. **Windows x64.** The first release.
2. **macOS on Intel, macOS on Apple Silicon, and Linux x64.** Next.
3. **Windows on ARM and Linux on ARM.** Later.

A platform is supported once its packages pass the release test (§10.1) on
that platform. Until then, the extension on an unsupported platform says so
plainly instead of trying an install that cannot work.

### 3.3 Inside the Steptix folder

```
<Steptix folder>/
  runtimes/
    1.3.0/          one folder per server version (§4.3 says which are kept)
    1.4.0/
  node/
    22.21.0/        Steptix's own copy of Node.js, only if it had to download one (§4.6)
  bin/
    steptix         the launcher the extension sets up (§5.5), only if needed
  .env              the machine key and server address, as today
```

`runtimes/` is the folder the extension already looks in today, so it keeps
its name.

## 4. Rules every scenario follows

The scenarios in §5 to §9 refer back to these by number.

### 4.1 One place for servers, one folder per version

Every server on the machine lives in `<Steptix folder>/runtimes/<version>/`.
The extension and the launcher look there and nowhere else when choosing what
to run. A folder is copied in under a temporary name and renamed when it is
complete, so a half-finished copy is never picked up.

### 4.2 Released together; the newest one runs

The extension, the launcher and the server are released together with one
version number. Extension 1.4.0 was tested with server 1.4.0, and that is the
server it installs.

Which server runs:

- **Normally, the newest one** in `runtimes/`. The extension and the launcher
  choose the same way, so the terminal and VS Code never run different
  versions.
- **Never one older than the extension or launcher asking.** Extension 1.4.0
  does not run server 1.3.0; it installs 1.4.0 (§6.2).
- **Unless the user chose one** with `steptix server use <version>` (§6.4).

VS Code and npm update at different times, so the server can be newer than
the extension or launcher talking to it. A server therefore keeps working with
an extension or launcher older than itself, and the release test checks that
(§10.1).

### 4.3 A running server is never changed; the previous version is kept

Updating never writes into a server's folder. A new version goes into a new
folder beside it. The running server carries on until it stops, and the next
start uses the new one.

Steptix keeps three kinds of version and removes the rest:

- the newest,
- the one before it, so going back needs no download (§6.4),
- one the user chose with `steptix server use`, if any.

A version is removed only when nothing is running from it. If something is,
it is removed the next time Steptix checks.

### 4.4 Nothing is downloaded twice

Before downloading a server, the extension checks whether one is already on
the machine: first in `runtimes/`, then in npm's own install of `steptix`
(§5.3). It downloads only when neither has the version it needs.

### 4.5 Ask before downloading, never after the user already chose

- **In VS Code**, installing the extension is not a request to download a
  server. The extension asks first, and says how big the download is.
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

## 5. Installing

### 5.1 Scenario 1: from a terminal only

**Before:** the user has Node.js 22.21 or later and npm. They are using npm,
so they have it.

1. **They run `npm i -g steptix`.** npm downloads the launcher and the server
   together, with its normal progress display. `steptix` now works in every
   new terminal, because npm's folder is already on PATH.
2. **They run their first `steptix` command,** any command. The launcher sees
   that its server version is not in `runtimes/` yet. It prints one line,
   *"Setting up Steptix 1.4.0 (first run only)…"*, copies the server from
   npm's folder into `runtimes/1.4.0/`, and then runs the command they typed.
   This takes a few seconds and needs no network.
3. **First-run setup** (§7) checks for a browser and an AI key.

**If their Node.js is too old:** npm warns during the install, and the
launcher refuses to run with *"Steptix needs Node.js 22.21 or later. You have
20.11. Install a newer Node.js from nodejs.org and run this again."*

**If they installed with `sudo`** (macOS and Linux): npm's copy is owned by
the administrator, but the first-run copy is made by the user into their own
Steptix folder, so it is theirs. Nothing later needs `sudo`.

### 5.2 Scenario 2: from the Marketplace only

**Before:** VS Code. Node.js is optional.

1. **They install Steptix from the Extensions view.** The extension starts
   and opens a short welcome page (§7).
2. **The extension looks for a server** (§4.4). It finds none.
3. **It asks:** *"Steptix needs its local server to run tests (about N MB to
   download). [Install] [Not now]"*. It asks when it first starts, so that
   the server is usually ready before the first Run. If they chose Not now, it
   asks again when they press Run.
4. **On Install**, with progress shown in the notification and detail in the
   Output panel:
   1. If no suitable Node.js is available (§4.6), it downloads its own copy
      into `<Steptix folder>/node/`.
   2. It uses that Node.js's npm to install the server, the same version as
      the extension, into `runtimes/<version>/`.
5. **The server starts** as it does today, and the Run carries on.
6. **The `steptix` command** is set up as in §5.5.

If they press Run while the download is still going, the Run waits for it
rather than failing.

### 5.3 Scenario 3: installed from a terminal, never run, then the Marketplace

The user ran `npm i -g steptix` but never ran a `steptix` command, then
installed the extension. The server is on the machine, in npm's folder, but it
was never copied into `runtimes/`, because that happens on the first command.

1. **They install the extension.**
2. **The extension looks in `runtimes/`.** It is empty.
3. **It looks for `steptix` on PATH** and finds the launcher npm installed.
   It runs `steptix server install`, which does exactly what the first
   terminal command would have done: copy the server from npm's folder into
   `runtimes/<version>/`. It reports the folder and version back.
4. **If that version is at least the extension's**, the extension uses it
   without asking anything, and says *"Using Steptix 1.4.0 installed with
   npm"*.
5. **If it is older**, the extension asks: *"Steptix 1.3.0 from npm is
   older than this extension (1.4.0). [Install 1.4.0] [Not now]"*.
   Install works as in §5.2 step 4. It does not update the user's npm install
   (§4.9). The terminal's `steptix` runs 1.4.0 from then on too, because the
   newest one runs (§4.2).
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
2. **It finds the server in `runtimes/`.** If it is at least the extension's
   version, it uses it, says which version and where from, and asks nothing.
   If it is older, as in §5.3 step 5.
3. **Nothing is downloaded**, and nothing about PATH is asked.

### 5.5 Scenario 5: from the Marketplace, then wanting the `steptix` command

The extension installed the server (§5.2). The user also wants `steptix` in a
terminal.

- **In VS Code's own terminals**, it already works. When the extension
  installs the server, it puts a launcher in `<Steptix folder>/bin/` and adds
  that folder to the PATH of VS Code's terminals only. Nothing outside VS Code
  changes.
- **For other terminals**, the extension asks once, after the first
  successful install: *"Use the steptix command in other terminals too? [Add
  it] [No thanks]"*.
  - Windows: it adds the folder to the end of the user's own PATH, leaving
    every other entry as it was.
  - macOS and Linux: it adds a link in `~/.local/bin` if that folder is on
    PATH, otherwise one line to the shell's startup file (`~/.zshrc` or
    `~/.bashrc`), and says which.
  - Terminals that are already open need to be reopened, and the message says
    so.
  - The launcher in `bin/` uses the Node.js the server uses (§4.6), so it
    works even for someone who never installed Node.js.
- **If `steptix` is already on PATH** (scenarios 3 and 4), the extension
  skips all of this.
- **If they later run `npm i -g steptix` anyway**, there are two launchers on
  PATH. Both run the newest server in `runtimes/`, so it makes no difference
  which one the terminal finds first.

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
3. **The first `steptix` command** copies the server into `runtimes/1.4.0/`,
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

1. `npm i -g steptix@latest` downloads the new launcher and server into npm's
   folder. Nothing in `runtimes/` changes, so a running server is not affected.
2. The next `steptix` command, or the extension's next Run, whichever comes
   first, copies the new version into its own folder (§4.1).
3. The previous version stays, and anything older is removed once nothing is
   running from it (§4.3).

### 6.2 Updating the extension

1. VS Code updates the extension from the Marketplace, on its own.
2. The new extension needs the server of its own version (§4.2). If that is
   not in `runtimes/`, it first checks npm's install (§5.3), then asks: *"This
   Steptix update needs server 1.4.0. [Update now] [Later]"*, and installs it
   as in §5.2.
3. If they choose Later, the next Run asks again, because the Run cannot work
   without it.
4. The terminal's `steptix` moves to the new version too (§4.2).

### 6.3 Updating while a server is running

The extension's server keeps running for up to 60 minutes after its last use.
An update never touches it (§4.3). It finishes what it is doing, stops when
idle, and the next start runs the new version. No one is asked to stop
anything.

### 6.4 Going back to an older version

The previous version is still installed (§4.3), so going back needs no
download.

1. **`steptix server use 1.3.0`** makes 1.3.0 the version both the terminal
   and the extension run, from the next start. `steptix server list` shows
   what is installed, which one runs, and where each came from.
2. **The extension must not be newer than the server it runs** (§4.2). If
   extension 1.4.0 finds the user chose 1.3.0, it says: *"You chose Steptix
   server 1.3.0, but this extension is 1.4.0. Install extension 1.3.0 to
   match (Extensions view → Steptix → Install Another Version), or go back to
   the newest server. [Use newest] [Show how]"*.
3. **`steptix server use newest`** undoes the choice.

A chosen version is not affected by updates: a newer version can still be
installed beside it, but the chosen one keeps running until the choice is
undone.

### 6.5 Switching Node.js versions

Tools such as nvm keep a separate npm folder for each Node.js version.

- **The terminal:** after switching, `steptix` may be missing, because it was
  installed under the other version. `npm i -g steptix` puts the launcher back.
  The server is still in `runtimes/`, so the first command has nothing to copy.
- **The extension:** uses the newly selected Node.js if it is 22.21 or later.
  If it is older, it uses Steptix's own copy if there is one, and otherwise
  offers to download one (§4.6).

### 6.6 Two VS Code windows at once

Both may notice there is no server. One installs, the other shows *"Waiting
for Steptix to finish installing in another window"* and continues when it is
done (§4.7). Neither asks twice.

## 7. First-run setup

Both ways in end with the same two checks, on the welcome page in VS Code and
as a printed message in a terminal:

1. **An AI key.** If none is set, it says where to put one. Helping a new
   user get a key in the first place is a later change (§12).
2. **A browser.** Steptix uses Google Chrome by default. If Chrome is not
   installed, it says so and offers `steptix browsers`, which downloads a
   browser Steptix can use instead.

The machine key is created the first time the server starts, as today. The
user never sees it.

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
- the launcher in `bin/`, and the PATH entry or startup-file line it added.

### 9.3 Installed both ways

Either uninstall removes the servers. If the npm launcher is still installed
afterwards, its next command copies its own server back in (§5.1 step 2),
which is the expected result: the user still has Steptix installed.

## 10. What changes in the repo

- **New:** the `steptix` npm package becomes the launcher, and the server
  moves to its own package. The server package leaves out what only the
  Electron desktop app needs (Electron, Vite, React, CodeMirror), as the
  runtime build already does (`scripts/build-runtime.mjs`). The desktop app is
  not shipped at all.
- **New:** the server package ships its exact tested dependency versions
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
  no runtime is installed. It will find, install and update servers as above.
- **Changed:** the extension is published to the Marketplace by a new
  `steptix` publisher, so its ID becomes `steptix.steptix-vscode` instead of
  `pkent.steptix-vscode`. VS Code treats that as a different extension: an
  existing `pkent.steptix-vscode` install has to be uninstalled once by hand,
  and the docs and CLAUDE.md that name the old ID change with it. Publishing
  also needs a PNG icon (the Marketplace does not accept SVG for it) and a
  Marketplace description.
- **Changed:** one version number for the extension, the launcher and the
  server (§4.2). The extension is at 0.5.x and the server at 1.0.0-beta.1
  today, so the first release picks a number for all three. The CLAUDE.md
  rule that bumps the extension's patch version on every change needs
  replacing to fit (§11).
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
| `npm i -g`, first command copies the server, a test runs | §5.1 |
| Extension with Node.js 22.21+ on PATH downloads only the server and runs on the user's Node.js | §5.2, §4.6 |
| Extension with no Node.js, or an older one, on PATH downloads Node.js and the server, a test runs | §5.2, §4.6 |
| npm install never run, then the extension: no download, uses npm's copy | §5.3 |
| Extension-installed server, `steptix` works in VS Code's terminal | §5.5 |
| Offline file and `.vsix` installed with the network switched off, a test runs | §5.6 |
| Update from npm while a server runs: the server keeps serving, the next start is the new version | §6.1, §6.3 |
| Extension needs a newer server: it installs it, and the terminal runs it too | §6.2 |
| The previous release's extension runs a test against this release's server | §4.2 |
| `server use` the previous version, both sides run it; `server use newest` undoes it | §6.4 |
| Only the newest, the previous and a chosen version are kept | §4.3 |
| Two windows install at once: one download, both work | §6.6 |
| Install interrupted, then retried | §8.3 |
| Each uninstall removes what §9 says, and nothing else | §9 |

## 11. Still to settle

1. **The server package's name.** The maintainer is settling it. The
   `steptix` organisation on npm exists (`@steptix/aigateway` is published
   there), so `@steptix/server` is available as a name.
2. **How builds between releases are numbered.** With one version number per
   release (§4.2), the extension's patch number can no longer go up on every
   change. That rule exists so the Extensions panel shows a new number after
   each install of a work-in-progress build. A suffix such as `1.4.0-dev.17`
   would keep that signal without using up release numbers.

## 12. Not in this spec

Each of these is a later change of its own:

- **Getting a new user an AI key.** §7 only says where the key goes.
- **Desktop permissions on macOS and Linux.** Desktop automation needs
  Accessibility and Screen Recording permission on macOS, and an X11 session
  on most Linux desktops. First-run setup will check and explain these once
  those platforms are supported.
