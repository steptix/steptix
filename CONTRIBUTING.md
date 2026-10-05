# Contributing to Steptix

Thanks for helping. This page says how to set up, what a change needs, and
how to send it.

## Before you start

- **For anything bigger than a small fix, open an issue first** so we can agree
  on the approach before you write the code.
- **Security problems do not go in issues.** See [SECURITY.md](SECURITY.md).

## Set up

You need Git and Node.js 22.21 or later. The repo is five npm projects (the
framework at the root, `runner-core/`, `steptix-vscode/`, `flick-vscode/` and
`fixtures/tools/`), and one command installs them all, plus Playwright's
Chromium:

```bash
git clone https://github.com/steptix/steptix.git
cd steptix
npm run setup
```

No keys or `.env` files are needed for the unit and integration suites.

## Run the tests

| Where | Command | What it covers |
| --- | --- | --- |
| repo root | `npm test` | The framework: parser, runner, server, CLI, MCP |
| `runner-core/` | `npm test` | The client runtime the extension and the Electron runner share |
| `flick-vscode/` | `npm test` | The Flick chat panel |
| `steptix-vscode/` | `npm test` | The Steptix extension's unit tests |
| `steptix-vscode/` | `npm run test:integration` | The extension inside a real VS Code, against a fake server. Opens a VS Code window; the first run downloads VS Code |

Each `npm test` builds first, so it never tests stale output. `npm run lint`
type-checks the framework.

The live suite (`npm run test:live` in `steptix-vscode/`) drives a real
browser and makes real, billed model calls with your own AI key. You don't
need to run it; a maintainer does before merging when a change needs it. The
[README](README.md#testing-the-steptix-extension) explains how.

## What a change needs

- **Tests for what you changed,** and all four unit suites passing.
- **It works on Windows, Linux and macOS.** Build test paths that are native
  to the platform (`path.resolve(path.sep, 'proj')`, `os.tmpdir()`), never a
  hard-coded `C:\…`. A test that is about one platform says so with
  `it.runIf(process.platform === 'win32')` or similar, and the others get their
  own case.
- **Tests that give the same answer anywhere, in any order.**
  - Wait on a condition, never a sleep or an elapsed time.
  - Let a server pick its own port (port 0).
  - Give each test run its own scratch directory, and remove it afterwards.
  - Restore any global you change, and read nothing from your own machine.
- **Tests drive only applications this repo controls:** the SecureBank site
  in `fixtures/test-app`, or the local desktop. Never a third-party website.
- **No real secrets in any file.** In tests, use fakes that say what they are,
  such as `'compile-api-key'`, never random-looking strings.
- **A version bump when the extension changes.** If your change touches code
  bundled into the Steptix extension (anything under `steptix-vscode/` outside
  its tests, or under `runner-core/`), bump the patch number of
  `steptix-vscode/package.json` and its `package-lock.json`.

[CLAUDE.md](CLAUDE.md) holds the full set of project conventions, with the
reasons behind them.

## Send a pull request

- Branch from `main`, and keep one topic per pull request.
- Say what changed and why, and how you tested it.
- CI runs the four unit suites on Windows. Workflows on pull requests from
  forks wait for a maintainer to approve them before they run.
- `main` only changes through pull requests, and a maintainer merges.

## License

Steptix is licensed under the [Apache License, Version 2.0](LICENSE). By
contributing, you agree that your contributions are licensed under it too.
