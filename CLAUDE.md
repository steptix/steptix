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
