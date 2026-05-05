# Project notes

## Running Flick in dev mode (Windows)

On Windows, always invoke `flick/run-dev.bat` with its **full path**, not by
bare name:

```
cmd //c "c:\Projects\vibe\ai-ui-automation\flick\run-dev.bat"
```

The bare-name form (`cmd //c run-dev.bat`) fails from the repo root because
the bat lives in `flick/`, producing:
`'run-dev.bat' is not recognized as an internal or external command`.

The wrapper exists to source MSVC's `vcvarsall.bat x64` before `npm run tauri
dev`, so Rust's linker picks up MSVC's `link.exe` instead of Git-for-Windows's.

## TestBench: bump the patch version on every change

Whenever you change code that ends up bundled into the TestBench VS Code
extension (anything under `testbench/`, **and** anything under `runner-core/`
since that's a `file:` dep bundled into the extension's `dist/`), bump the
patch field in `testbench/package.json` (e.g. `0.1.1` → `0.1.2`) as part of
the same change.

The install/verify loop is then:

```powershell
cd c:\Projects\vibe\ai-ui-automation\testbench
npm run build
npm run package
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
    --install-extension testbench-<new-version>.vsix --force
```

Then reload the VS Code window. The Extensions panel will show the new
version number, which is how the user confirms the install actually picked
up the new code — without a bump, the installed copy and the stale one share
a directory name and there's no visible signal that anything changed.

Plain `code` from PowerShell on this machine resolves to the GUI exe, which
rejects `--install-extension`. Always invoke the CLI shim at the full path
above.
