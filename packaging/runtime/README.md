# Windows runtime beta

The installer builds a server and CLI distribution for Windows x64. It does
not bundle Node.js, Playwright browsers, the Electron runner, or the VS Code
extension. Node.js x64 22.21 or later must be available on PATH, or selected
with `STEPTIX_NODE`.

The default installation is per-user, requires no elevation, and lives at
`%LOCALAPPDATA%\steptix\runtimes\1.0.0-beta.1`. Each version gets its own
Windows Installed Apps entry. Uninstalling preserves shared keys, browser
downloads and test projects. Stop the server before uninstalling.

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

1. **Install.** It runs the installer silently. The runtime registers with
   Installed Apps.
2. **CLI.** It runs the CLI through `steptix.cmd`: version, help, `browsers`,
   `init`, then a headless Chrome test with compiled TypeScript steps and a
   custom tool.
3. **VS Code.**
   - It opens VS Code with the extension from this checkout, a fresh profile,
     no machine key, and Node found on PATH.
   - It sets the two User settings below, with nothing listening.
   - It presses Run.
   - It checks that the extension started the installed server through
     `cmd.exe` → `steptix.cmd` → the launcher, that the server generated the
     machine key, and that every step passed.
4. **Server.** It runs the Sessions API with that key, checks tool source
   maps, then stops the server with `steptix.cmd stop`.
5. **Uninstall.** It runs the Installed Apps entry's uninstall command. Then it
   checks that the install folder and the entry are gone and that the project
   and the key are untouched.

The installer's `/TESTMODE=<id>` switch exists for this test. With it, the
Installed Apps entry is registered under a key of its own and is labelled
"(installer test <id>)", so a real install of the same version is never
touched. It creates no Start menu folder. The test removes its entry even when
it fails.

Running the test needs a desktop session (it opens a VS Code window), Google
Chrome, and `steptix-vscode`'s dependencies installed. It makes no AI calls
and uses a temporary `%LOCALAPPDATA%`, so your machine key and settings are
not used. It keeps its temporary folder for diagnosis. To re-check an
installer by hand:

```powershell
node scripts/verify-runtime.mjs dist-runtime/SteptixRuntimeSetup-<version>-win-x64.exe
```

## Use with the current extension

The extension does not yet discover this runtime automatically. In VS Code
**User** settings, replace the example user path with your actual path:

```json
{
  "steptix.serverAutoStart.command": "\"C:\\Users\\YOUR_NAME\\AppData\\Local\\steptix\\runtimes\\1.0.0-beta.1\\steptix.cmd\" serve --idle-timeout 60",
  "steptix.serverAutoStart.cwd": "C:\\Users\\YOUR_NAME\\AppData\\Local\\steptix\\runtimes\\1.0.0-beta.1"
}
```

Keep the project's `SERVER_URL` pointed at the server, normally
`http://127.0.0.1:3100`. Use the existing extension server commands to start
it. The `serve` launcher enables a localhost Node inspector on an available
port. Standalone TypeScript tools can import `steptix/tools` and
`steptix/codebehind` through the runtime when their project has no framework
dependency; any installed project dependency takes precedence. Other custom
tool dependencies still belong in the test project. Editor type checking
still needs the framework's type declarations available in the project.

From a test project's PowerShell terminal:

```powershell
$runtime = "$env:LOCALAPPDATA\steptix\runtimes\1.0.0-beta.1\steptix.cmd"
& $runtime --help
& $runtime init
& $runtime run tests/example.md
& $runtime browsers install firefox
```

Browser installation uses the Playwright version packaged in the runtime.
It keeps the existing `%LOCALAPPDATA%\ms-playwright` cache unless
`PLAYWRIGHT_BROWSERS_PATH` overrides it. Steptix's current default Chromium
channel uses installed Google Chrome; downloading Playwright Chromium does
not change that default. The browser installer command is included, but
downloads require network access.

Automatic extension discovery, managed upgrades, runtime selection and a
dedicated runtime-management command family remain future work.
