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
node scripts/build-runtime.mjs 1.0.0-beta.1
node scripts/verify-runtime.mjs dist-runtime/SteptixRuntimeSetup-1.0.0-beta.1-win-x64.exe
```

The build refuses to overwrite an existing staged payload directory. Remove
only the generated `dist-runtime/steptix-runtime-<version>-win-x64` directory
before rebuilding that version. `STEPTIX_GIT` can select a Git executable
when Git is not on PATH.

Outputs in `dist-runtime/` include the installer, its SHA-256 checksum, an
uncompressed payload, and a package/file inventory. Only tracked template
files are eligible for packaging; local `.env` files, browser profiles,
reports and project dependencies are excluded. Dependency license files
and a third-party notice inventory are retained. This local beta is unsigned.

The verifier silently installs to a temporary directory containing spaces
and skips Windows registry/Start menu integration using `/TESTMODE`.
It uses a separate profile and generated test key, an installed Chrome
browser, and no AI calls. Temporary diagnostic directories are retained.

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
