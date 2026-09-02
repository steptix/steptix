# The env overlay that silently wins — make the setup command and the 401 say so

Status: draft — for review
Builds on: [copilot-lm-bridge.md](copilot-lm-bridge.md) (the setup command and the
bridge's 401), the env picker (`testbench-native/src/extension/env-selector.ts`), and the
overlay rule in [project-scoped-data-dir-and-env.md](project-scoped-data-dir-and-env.md).

## What we're building

Two small changes that between them remove a whole class of "it should work but
doesn't", found the hard way the first time anyone pointed the Copilot bridge at
a real project.

**Today.** A user runs **TestBench: Use Copilot for AI**. It writes
`AI_MODEL`, `AI_GATEWAY_URL` and `AI_API_KEY` into the project's `.env`,
correctly, and says so. They run a test. Every AI call fails:

```
401 The TestBench Copilot bridge needs "Authorization: Bearer <token>" with the
token from AI_API_KEY, written by "TestBench: Use Copilot for AI". If that line
came from another machine it will not work here …
```

Nothing in that message is true of their situation. The token is this machine's,
the file is right, the command did run here. What actually happened is that the
workspace has an **active environment** — say `uat` — so every run composes
`.env.uat` **over** `.env`, and `.env.uat` carries its own `AI_API_KEY`. The
bridge is handed someone else's key and correctly refuses it.

**After.** Setup notices the overlay before it writes and offers to handle it;
and if a mismatch still reaches the bridge, the 401 names the overlay as a
candidate cause instead of sending the user to rerun a command that will not
help.

### What it looks like in practice

**You run** *TestBench: Use Copilot for AI* in a workspace whose active env is `uat`,
where `.env.uat` sets `AI_API_KEY`.
**You get** a choice, before anything is written:

> The active environment **uat** overrides `AI_API_KEY` from `.env.uat`, which
> would shadow the bridge token. Write the token to **both** files, write to
> `.env.uat` **only**, or **continue anyway**?

**You run** a test where a stale overlay still shadows the token.
**You get** a 401 whose text names the actual suspect:

> …the token sent does not match this machine's. The active environment `uat`
> sets `AI_API_KEY` in `.env.uat`, which overrides `.env` — check there first.
> Otherwise rerun "TestBench: Use Copilot for AI" in this window.

## Why this is worth doing

The overlay rule is correct and stays: most-specific-wins is what makes named
environments useful, and it is the same rule the server
(`resolveEnvBundle`) and the CLI already follow. The defect is that **nothing
tells you it is in force at the moment it matters**:

- The setup command writes to `.env` and reports success, having never looked at
  `.env.<activeEnv>` — so its own success message is misleading.
- The 401 lists three causes and the real one is not among them; worse, its
  advice ("rerun the setup command") reproduces the exact failure, because
  rerunning writes `.env` again.
- The one ambient signal, the env picker in the status bar, is hidden unless a
  `.md` file is the active tab (`env-selector.ts` `refresh()`), which it usually
  is not while someone edits `.env` or reads an error.

Cost, measured once: a working configuration that took several rounds of
debugging to explain, with the user reasonably concluding the bridge was broken.

## Part A — setup notices the overlay

In `lm-bridge-setup.ts`, after `resolveEnvTarget()` and before the confirm:

1. Read the active env (`EnvSelector.activeEnv()`, already exported and already
   read by `run-controller.ts`).
2. If it is set, look for `<workspace>/.env.<name>`. Absent → no change in
   behaviour.
3. Present → parse it (`parseEnv` from runner-core, already used) and check for
   an `AI_API_KEY` key. Absent → no change.
4. Present and conflicting → offer three choices, and let the answer decide
   which file(s) the existing write plan targets:

   | Choice | Effect |
   |---|---|
   | **Both** (default) | write the trio to `.env` and the token to `.env.<name>` |
   | **Overlay only** | write the trio to `.env.<name>`; leave `.env` untouched |
   | **Continue anyway** | today's behaviour, for someone who knows why |

Only `AI_API_KEY` is checked. An overlay that sets `AI_MODEL` or
`AI_GATEWAY_URL` is a deliberate per-environment choice and none of setup's
business; the key is the one whose mismatch produces an error that names the
wrong cause.

The **Both** default is chosen over "delete the overlay's key" deliberately.
Deleting is often the tidier end state — in the case that prompted this, the
overlay's key was a byte-identical copy of the machine-wide key and therefore
pure redundancy — but setup cannot know that, and silently removing a credential
from a file it was not asked to touch is the wrong default. Say what was written
where, and let the user tidy.

**The staleness this creates must be stated, not hidden.** Writing the token to
two files means a later rerun of setup — to change model, say — updates both
only if the overlay is still active then. The summary says which files were
written, so a user switching environments has been told where to look.

## Part B — the 401 names the overlay

`lm-bridge-core.ts`'s `unauthorizedError()` is in the import-free core and has no
workspace access, which is right — it must stay testable without a VS Code host.
So the bridge does not discover the overlay; it is **told** at construction.

The extension already knows the active env and can cheaply check whether
`.env.<name>` sets `AI_API_KEY`. It passes an optional hint into the bridge
(`{ activeEnv, overlaySetsKey }`), refreshed on the config-change listener that
already exists for `lmBridge.enabled`/`port`. When the hint is present the 401
gains one sentence naming the file; when absent the text is exactly today's.

Two properties worth keeping:

- The 401 stays a **401 with no detail about the expected token** — the hint
  names a file, never a value.
- The core module stays free of `vscode` imports, so `lm-bridge-core.test.js`
  continues to run under `node --test` with no host.

## Part C — make the picker findable (small)

The status-bar item hides unless a `.md` file is active. That is defensible for
noise, but it means the setting is invisible exactly when someone is debugging
`.env`. Two cheap improvements, either or both:

- Show the item whenever the workspace has any `.env.*` or `data/*.json` — i.e.
  whenever an environment is *selectable* — rather than keying on the active
  editor. Keep the same click target.
- When an env is active, include it in the run's own output line, which is read
  far more often than the status bar.

Out of scope: changing the overlay precedence, or making `activeEnv` anything
other than a workspace setting.

## Tests

- **Unit (extension, no host):** the overlay-detection helper — no active env;
  active env with no `.env.<name>`; present but no `AI_API_KEY`; present with
  one. And the write planner: each of the three choices produces the right set
  of file writes, with `.env` untouched under **Overlay only**.
- **Unit (core):** `unauthorizedError()` with and without the hint — the hinted
  form names the file, neither form contains the expected token. This is the
  regression guard for the leak.
- **Integration (electron harness):** setup in a workspace with a conflicting
  overlay writes both files under the default and prompts once; setup with no
  active env writes exactly what it does today (the no-regression case, which
  matters more than the new path).
- **Manual, needs a real seat:** the case that prompted this — active env with a
  conflicting key, run a test, confirm the 401 now names the overlay.

## Rollout

`testbench-native` only. Patch bump, package and install per the repo loop. No
server rebuild, no framework change, no library change.

## Open questions

1. **Should "Both" or "Overlay only" be the default?** Both is proposed as the
   least surprising. Overlay-only is arguably more correct — the overlay is what
   actually runs — but leaves `.env` stale for anyone who later clears the env.
2. **Should Part C's status-bar change be split out?** It is unrelated to the
   bridge and touches a shared control; a reviewer may want it separate.
3. **Is `AI_GATEWAY_URL` worth checking too?** An overlay pointing it elsewhere
   breaks the bridge just as thoroughly, but produces a connection error naming
   the address rather than a misleading 401 — arguably self-explaining already.
