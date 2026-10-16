# Installing Steptix: one install for VS Code and the terminal

**Status:** spec, for build.
**Opened:** 2026-10-17
**Scope:** Windows, macOS and Linux. Replaces the Windows-only runtime
installer in `packaging/runtime/` (§9).

## 1. What this is

Steptix has three parts a user wants: the VS Code extension, the `steptix`
command for the terminal, and the server both of them talk to. Today the
extension is installed by hand from a `.vsix` file, and the server and command
come from a Windows-only installer that also needs Node.js installed first.

This spec replaces that with two ways in, which end in the same place:

- **From a terminal:** `npm i -g steptix`.
- **From VS Code:** install Steptix from the Extensions Marketplace.

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

## 3. What gets installed, and where

Two packages are published to npm:

| Package | What it is | Size |
| --- | --- | --- |
| `steptix` | The launcher. Depends on the server package, so installing it downloads both. | Small |
| `@steptix/server` (name to confirm, §11) | The server. | Large |

The extension is published to the VS Code Marketplace.

Inside the Steptix folder:

```
<Steptix folder>/
  runtimes/
    1.2.0/          one folder per server version
    1.3.0/
  node/
    22.21.0/        Steptix's own copy of Node.js, only if it had to download one (§4.6)
  bin/
    steptix         the launcher the extension sets up (§5.5), only if needed
  .env              the machine key and server address, as today
```

`runtimes/` is the folder the extension already looks in today, so it keeps
its name.

## 4. Rules every scenario follows

The scenarios in §5 to §8 refer back to these by number.

### 4.1 One place for servers, one folder per version

Every server on the machine lives in `<Steptix folder>/runtimes/<version>/`.
The extension and the launcher look there and nowhere else when choosing what
to run. A folder is copied in under a temporary name and renamed when it is
complete, so a half-finished copy is never picked up.

### 4.2 The newest one runs

The extension and the launcher both run the newest server in `runtimes/`, as
long as it is at least the oldest version they work with. Each of them states
that oldest version. Because they choose the same way, the terminal and VS Code
never run different versions.

### 4.3 A running server is never changed

Updating never writes into a server's folder. A new version goes into a new
folder beside it. The running server carries on until it stops, and the next
start uses the new one. An old folder is removed only when nothing is running
from it. If something is, it is removed the next time Steptix checks.

### 4.4 Nothing is downloaded twice

Before downloading a server, the extension checks whether one is already on
the machine: first in `runtimes/`, then in npm's own install of `steptix`
(§5.3). It downloads only when neither has a version new enough.

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
its own copy stays unused until **Steptix: Uninstall Server** removes it (§9.2).

Any Node.js of the right version can run any server folder, whichever Node.js
installed it.

### 4.7 One install at a time

Two VS Code windows, or a window and a terminal, can both notice that no
server is installed. Only one installs. The other waits for it, then uses the
result. The same holds for removing old versions.

### 4.8 Always say what is running

- `steptix --version` prints the launcher's version, the server version it
  will run, and the folder it runs it from.
- The extension shows the server version and where it came from (npm, or
  installed by the extension) in its status and in the Output panel.

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
   *"Setting up Steptix 1.2.0 (first run only)…"*, copies the server from
   npm's folder into `runtimes/1.2.0/`, and then runs the command they typed.
   This takes a few seconds and needs no network.
3. **First-run setup** (§7) checks for Google Chrome and an AI key.

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
   2. It uses that Node.js's npm to install the server into
      `runtimes/<version>/`.
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
4. **If that version is new enough** for the extension, the extension uses it
   without asking anything, and says *"Using Steptix 1.2.0 installed with
   npm"*.
5. **If it is too old**, the extension asks: *"Steptix 1.2.0 from npm is
   older than this extension needs (1.3.0). [Install 1.3.0] [Not now]"*.
   Install works as in §5.2 step 4. It does not update the user's npm install
   (§4.9). The terminal's `steptix` runs 1.3.0 from then on too, because the
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
2. **It finds the server in `runtimes/`.** If it is new enough, it uses it,
   says which version and where from, and asks nothing. If it is too old, as
   in §5.3 step 5.
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

## 6. Living with it

### 6.1 Updating from a terminal

1. `npm i -g steptix@latest` downloads the new launcher and server into npm's
   folder. Nothing in `runtimes/` changes, so a running server is not affected.
2. The next `steptix` command, or the extension's next Run, whichever comes
   first, copies the new version into its own folder (§4.1).
3. The old version is removed once nothing is running from it (§4.3).

### 6.2 Updating the extension

1. VS Code updates the extension from the Marketplace, on its own.
2. If the new extension needs a newer server than the newest in `runtimes/`, it
   first checks npm's install (§5.3), then asks: *"This Steptix update needs
   server 1.4.0. [Update now] [Later]"*, and installs it as in §5.2.
3. If they choose Later, the next Run asks again, because the Run cannot work
   without it.
4. The terminal's `steptix` moves to the new version too (§4.2).

### 6.3 Updating while a server is running

The extension's server keeps running for up to 60 minutes after its last use.
An update never touches it (§4.3). It finishes what it is doing, stops when
idle, and the next start runs the new version. No one is asked to stop
anything.

### 6.4 Going back to an older version

`steptix server remove 1.4.0` removes that version, and the newest remaining
one runs from then on. `steptix server list` shows what is installed, which
one runs, and where each came from.

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

1. **An AI key.** If none is set, it says where to put one and what it is
   for. In VS Code the welcome page has a field for it.
2. **A browser.** Steptix uses Google Chrome by default. If Chrome is not
   installed, it says so and offers `steptix browsers`, which downloads a
   browser Steptix can use instead.

The machine key is created the first time the server starts, as today. The
user never sees it.

## 8. When things go wrong

### 8.1 No network, or npm's registry is blocked

*"Could not download the Steptix server: <npm's reason>. If your company uses
its own npm registry, check that npm works in a terminal (`npm view
steptix`). [Retry] [Show details]"*. Nothing half-installed is left behind
(§4.1).

### 8.2 nodejs.org is blocked

*"Could not download Node.js. Install Node.js 22.21 or later yourself and
press Retry. [Open nodejs.org] [Retry]"*. Once a suitable `node` is on PATH,
Retry uses it (§4.6).

### 8.3 Install stopped partway

VS Code closed, the machine slept, the disk filled up. The incomplete copy
was never renamed into place (§4.1), so it is ignored and cleaned up on the
next attempt, which starts again.

### 8.4 Someone has the Windows installer beta

The beta installed into the same `<Steptix folder>/runtimes/<version>/`
folders, but its files are laid out differently from an npm install. During
the changeover, the extension and the launcher recognise both layouts and
treat a beta folder like any other version: the newest runs. The beta is
removed from Windows' Installed Apps as before. Whether to keep this support at all
depends on whether the beta reached anyone (§11).

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
  desktop UI needs (Electron, Vite, React, CodeMirror), as the runtime build
  already does (`scripts/build-runtime.mjs`).
- **New:** the server package ships its exact tested dependency versions
  (`npm-shrinkwrap.json`). npm ignores a package's lock file when someone
  installs it, so without this each user would get whatever versions are
  newest that day, not the ones that were tested.
- **New:** launcher commands `server install`, `server list`, `server remove`,
  `uninstall`, and the version details in `--version`.
- **Changed:** the extension's server lookup
  (`steptix-vscode/src/extension/server-manager.ts`). Today it gives up when
  no runtime is installed. It will find, install and update servers as above.
- **Changed:** the extension is published to the Marketplace. That needs a
  publisher account, a PNG icon (the Marketplace does not accept SVG for it)
  and a Marketplace description.
- **Retired:** the Windows installer (`packaging/runtime/`,
  `scripts/build-runtime.mjs`, `scripts/verify-runtime.mjs`) and the
  CLAUDE.md section about it, once this ships. Its end-to-end checks move to
  the new test below.
- **Release:** npm packages are published from GitHub Actions with npm's
  provenance record, which shows which commit and build produced them.

### 10.1 Every release is tested end to end

The rule for the Windows installer carries over: nothing is published that
was not installed and run the way a user would. On Windows, macOS and Linux,
from the exact package files about to be published, served by a private test
copy of the npm registry:

| Check | Scenario |
| --- | --- |
| `npm i -g`, first command copies the server, a test runs | §5.1 |
| Extension with Node.js 22.21+ on PATH downloads only the server and runs on the user's Node.js | §5.2, §4.6 |
| Extension with no Node.js, or an older one, on PATH downloads Node.js and the server, a test runs | §5.2, §4.6 |
| npm install never run, then the extension: no download, uses npm's copy | §5.3 |
| Extension-installed server, `steptix` works in VS Code's terminal | §5.5 |
| Update from npm while a server runs: the server keeps serving, the next start is the new version | §6.1, §6.3 |
| Extension needs a newer server: it installs it, and the terminal runs it too | §6.2 |
| Two windows install at once: one download, both work | §6.6 |
| Install interrupted, then retried | §8.3 |
| Each uninstall removes what §9 says, and nothing else | §9 |

## 11. Open questions

1. **The server package's name.** `@steptix/server` needs the `steptix`
   organisation on npm. `steptix-server` is the alternative.
2. **Keep the Windows installer for offline machines?** Some companies' machines
   cannot reach npm or nodejs.org at all. A single download that needs neither
   would serve them, at the cost of keeping the installer and its tests alive.
3. **Did the Windows installer beta reach anyone?** If not, §8.4 can go.
4. **Marketplace publisher.** The extension ID is `pkent.steptix-vscode` today.
   A `steptix` publisher would make it `steptix.steptix-vscode`, which is a new
   extension as far as VS Code is concerned. Changing it later moves every user
   by hand, so it is worth deciding before the first public release.
5. **Keep one previous version for going back?** §4.3 removes old versions as
   soon as nothing runs them. Keeping the last one would make going back
   (§6.4) instant, at the cost of disk space.
