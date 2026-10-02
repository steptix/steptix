# Windows runtime beta

The installer builds a server and CLI distribution for Windows x64. It does
not bundle Node.js, Playwright browsers, the Electron runner, or the VS Code
extension. Node.js x64 22.21 or later must be available on PATH, or selected
with `STEPTIX_NODE`.

The default installation is per-user, requires no elevation, and lives at
`%LOCALAPPDATA%\steptix\runtimes\1.0.0-beta.1`. Each version gets its own
Windows Installed Apps entry. Uninstalling preserves shared keys, browser
downloads and test projects. Stop the server before uninstalling.

## On PATH

The installer's "Add steptix to PATH" option is ticked by default, and a
silent install takes it unless you pass `/NOPATH`. It puts `steptix` in every
new terminal:

- `%LOCALAPPDATA%\steptix\bin` holds [steptix.cmd](bin/steptix.cmd) and
  [run-newest-runtime.cjs](bin/run-newest-runtime.cjs). That one folder serves
  every version. It runs the newest runtime under
  `%LOCALAPPDATA%\steptix\runtimes`, chosen the way the extension chooses the
  one it starts, so a terminal and VS Code never run different versions.
  `steptix-vscode/tests/path-runtime-parity.test.js` holds the two choices
  together.
- The folder goes at the end of the user's own `Path` value
  (`HKCU\Environment`), which needs no administrator rights. Every other entry
  stays as written, `%VARIABLE%` entries unexpanded, and the value stays
  `REG_EXPAND_SZ`. If the folder is already there in any spelling, nothing is
  added.
- If the installer cannot change the value safely, it leaves it alone and says
  how to add the folder by hand. That happens when the value is too long for
  NSIS's 8,192-character strings, or is not a string at all.
- Uninstalling the last runtime removes the two files, the folder if nothing
  else is in it, and the `Path` entry. While another runtime is installed,
  they stay, because the folder still runs that one.

Terminals and VS Code windows that are already open keep their old `PATH`
until they are restarted. The logic is in [user-path.nsh](user-path.nsh).

## Silent install

`/S` installs with no window. Add `/NOPATH` to leave `PATH` alone. The
installer is a GUI program, so PowerShell does not wait for it unless you use
`Start-Process -Wait`:

```powershell
Start-Process .\SteptixRuntimeSetup-1.0.0-beta.1-win-x64.exe -ArgumentList '/S' -Wait
Start-Process .\SteptixRuntimeSetup-1.0.0-beta.1-win-x64.exe -ArgumentList '/S', '/NOPATH' -Wait
```

`Uninstall.exe /S` uninstalls with no window. It copies itself to a temporary
folder and returns at once, then removes the runtime, so wait for the runtime
folder to disappear rather than for the command to finish.

A silent run never shows a dialog. Each one it could show has a silent answer
(`/SD`), because without one NSIS shows the dialog even under `/S`, and a
script waits on it indefinitely. An install that cannot proceed, on 32-bit
Windows for example, exits with code 2. An uninstall that cannot proceed,
because the folder's installation marker is missing or names another version,
removes nothing. Its exit code goes to the temporary copy, not to you, so the
sign is that the runtime folder stays.

`/D=<folder>` installs elsewhere, but neither the extension nor `steptix` on
PATH looks outside `%LOCALAPPDATA%\steptix\runtimes`, so a runtime installed
there is not found. If you use it anyway, it must be the last argument, and
unquoted even when the path has spaces.

## Build

From a Windows x64 checkout, install the locked dependencies and compile:

```powershell
npm ci
npm run build
```

Use a Unicode NSIS compiler, setting `STEPTIX_MAKENSIS` to its `makensis.exe`.
This beta was built with the portable compiler from
[electron-builder-binaries nsis-3.0.4.1](https://github.com/electron-userland/electron-builder-binaries/releases/tag/nsis-3.0.4.1).
Its archive SHA-512, expressed as base64, is:

```text
VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==
```

The default compiler path is `build-tools/nsis/compiler/Bin/makensis.exe`.
Then run:

```powershell
node scripts/build-runtime.mjs
```

The version is the root `package.json`'s unless you pass one. The build runs
`npm run build` first, so the installer carries this checkout's code and build
stamp, and it replaces any earlier output for the same version.
`STEPTIX_GIT` can select a Git executable when Git is not on PATH.

Outputs in `dist-runtime/` include the installer, its SHA-256 checksum, its
verification report, an uncompressed payload, and a package/file inventory.
Only tracked template files are eligible for packaging; local `.env` files,
browser profiles, reports and project dependencies are excluded. Dependency
license files and a third-party notice inventory are retained. This local beta
is unsigned.

### Every installer is tested end to end

The build compiles the installer into `dist-runtime/unverified/` and runs
`scripts/verify-runtime.mjs` on it. The installer moves to `dist-runtime/`
only if every check passes. If the test fails, the build fails and the
installer stays in `unverified/`. There is no flag to skip the test.

The test does what a user does, in a temporary folder whose path has spaces:

1. **Install.** It runs the installer silently with `/NOPATH`. The runtime
   registers with Installed Apps, and a seeded user `Path` value and the PATH
   folder are left alone.
2. **CLI.** It runs the CLI through `steptix.cmd`: version, help, `browsers`,
   `init`, then a headless Chrome test with compiled TypeScript steps and a
   custom tool.
3. **VS Code.**
   - It opens VS Code with the extension from this checkout, a fresh profile
     with no Steptix settings, a project with no `.env`, no machine key, and
     Node found on PATH. The machine `.env` holds only `SERVER_URL`, on a free
     port, with nothing listening.
   - It presses Run.
   - It checks that the extension found the installed runtime and started its
     server through `cmd.exe` → `steptix.cmd` → the launcher, on that port,
     that the server generated the machine key, and that every step passed.
4. **Server.** It runs the Sessions API with that key, checks tool source
   maps, then stops the server with `steptix.cmd stop`.
5. **PATH.** It reinstalls silently over the same folder without `/NOPATH`.
   The PATH folder must be added to the end of the seeded `Path`, with every
   other entry and the value's type kept. Then it runs `steptix --version` the
   way a new terminal would, with the `Path` value the installer wrote. Beside
   the real runtime are an older one and a newer one missing its launch files,
   and `steptix` must run neither.
6. **Refused uninstall.** It runs a copy of the uninstaller silently on a
   folder whose marker is missing, then on one whose marker names another
   version. Each must exit with an error code and no dialog, and remove
   nothing.
7. **Uninstall.** It runs the Installed Apps entry's uninstall command. Then it
   checks that the install folder and the entry are gone and that the project
   and the key are untouched. The newer folder missing its launch files does
   not count as a runtime, so this was the last one: the PATH folder and its
   entry must be gone, and the rest of `Path` as it was.

The installer's `/TESTMODE=<id>` switch exists for this test. With it, the
Installed Apps entry is registered under a key of its own and is labelled
"(installer test <id>)", so a real install of the same version is never
touched. It creates no Start menu folder. It adds to the `Path` value in
`HKCU\Software\SteptixInstallerTest-<id>` instead of `HKCU\Environment`, so
the PATH of whoever runs the test is never touched either. The test removes
its entry and that key even when it fails.

Running the test needs a desktop session (it opens a VS Code window), Google
Chrome, and `steptix-vscode`'s dependencies installed. It makes no AI calls
and uses a temporary `%LOCALAPPDATA%`, so your machine key and settings are
not used. It keeps its temporary folder for diagnosis. To re-check an
installer by hand:

```powershell
node scripts/verify-runtime.mjs dist-runtime/SteptixRuntimeSetup-<version>-win-x64.exe
```

## Use with the extension

Nothing to configure. When you run a test and no server is listening, the
extension starts the newest runtime under `%LOCALAPPDATA%\steptix\runtimes`
itself, as `steptix.cmd serve --port <port> --idle-timeout 60`.

It finds the server the same way for every project:

1. `SERVER_URL` in the project's `.env`, if the project has one and sets it.
2. The `SERVER_URL` environment variable.
3. `SERVER_URL` in `%LOCALAPPDATA%\steptix\.env`, the file that also holds
   the machine key.
4. `http://127.0.0.1:3100`, where `steptix serve` listens by default.

So a project needs no `.env` at all. To run the server on another port for
every project, add a line like `SERVER_URL=http://127.0.0.1:3200` to
`%LOCALAPPDATA%\steptix\.env`; the extension starts the runtime on that port.

Two User settings change this. `steptix.serverAutoStart.command` starts
something else instead, such as a framework checkout; it then needs
`steptix.serverAutoStart.cwd` as well. Turning off
`steptix.serverAutoStart.useInstalledRuntime` means nothing is started unless
a command is set.

The Steptix: Start Server, Stop Server and Server Status commands use the same
server. The `serve` launcher enables a localhost Node inspector on an available
port. Standalone TypeScript tools can import `steptix/tools` and
`steptix/codebehind` through the runtime when their project has no framework
dependency; any installed project dependency takes precedence. Other custom
tool dependencies still belong in the test project. Editor type checking
still needs the framework's type declarations available in the project.

From a test project's terminal, with `steptix` on PATH:

```powershell
steptix --help
steptix init
steptix run tests/example.md
steptix browsers install firefox
```

Without it, call a version's own `steptix.cmd`, such as
`& "$env:LOCALAPPDATA\steptix\runtimes\1.0.0-beta.1\steptix.cmd" --help`.

Browser installation uses the Playwright version packaged in the runtime.
It keeps the existing `%LOCALAPPDATA%\ms-playwright` cache unless
`PLAYWRIGHT_BROWSERS_PATH` overrides it. Steptix's current default Chromium
channel uses installed Google Chrome; downloading Playwright Chromium does
not change that default. The browser installer command is included, but
downloads require network access.

Managed upgrades, choosing a runtime other than the newest, and a dedicated
runtime-management command family remain future work.
