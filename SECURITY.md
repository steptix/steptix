# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: on the repository's **Security** tab, choose
**Report a vulnerability**. Only the maintainers can see the report.

Include what you can of:

- what an attacker can do, and what they need first (a cloned repo, a local
  account, network access, a malicious page)
- the Steptix version: `steptix --version`, the VS Code extension's version,
  or the runtime installer you used
- your operating system
- steps to reproduce, or a proof of concept

You will get a reply within 7 days. We'll keep you posted until a fix ships,
and credit you in the advisory unless you'd rather not be named.

## Supported versions

Steptix is in beta. Fixes go into the latest release only:

| Component | Supported |
| --- | --- |
| Steptix VS Code extension | the latest 0.5.x pre-release |
| Steptix runtime (Windows installer) | the latest release |
| `steptix` npm package and CLI | the latest release |

## What Steptix trusts, by design

Steptix runs tests written in a project, and some of a project is code. These
are how it is meant to work, not vulnerabilities:

- **A project's code runs with your permissions.** Tools under `tools/src/`
  and compiled code-behind (`*.steps.ts`) are TypeScript from the project,
  executed by the server when a test runs. Run only projects you trust.
- **`[use computer]` steps drive the real mouse and keyboard** of the machine
  the server runs on.
- **Your AI provider sees what a run sends it:** step text, page content and,
  when enabled, screenshots.

## What is worth reporting

Anything that breaks one of these boundaries:

- **The local server.** The Sessions API server listens on `127.0.0.1` unless
  told otherwise, and every request needs the machine key
  (`STEPTIX_SERVER_API_KEY` in `%LOCALAPPDATA%\steptix\.env`, `~/.steptix/.env`
  elsewhere). A way to use it without the key, or to reach it from another
  machine with default settings, is a vulnerability.
- **Opening is not running.** Opening a folder or cloning a repo must not make
  Steptix run anything. The command that auto-starts the server is a
  machine-scoped setting that a workspace cannot set. A way around that, or any
  other way for a repo to run code before you run its tests, is a vulnerability.
- **The MCP server's allowed roots.** It touches only the directories
  `STEPTIX_MCP_ROOTS` names, or its own working directory when that is unset.
  A way to run a test or read a file outside them is a vulnerability.
- **Secrets stay masked.** The secrets a run uses are masked in what Steptix
  prints and saves: the console, logs and reports. A secret that shows up there
  in clear is a vulnerability.
- **The runtime installer** writing outside its install folder, or needing more
  privilege than a per-user install.
