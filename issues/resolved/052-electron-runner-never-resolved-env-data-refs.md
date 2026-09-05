# 052 — The Electron runner never resolved `${env.X}` / `${data.x}` in step text

**Status:** ✅ **RESOLVED — implemented + tested (2026-09-05).**
**Area:** [src/ui/main/runner-adapter.ts](../../src/ui/main/runner-adapter.ts) (`executeRun`, `resolveStepText`, `steer`), [src/cli/commands/ui.ts](../../src/cli/commands/ui.ts) (`--env` forwarding)
**Related:** [stories/variable-assignment.md](../../stories/variable-assignment.md) §Still open — where the gap was first written down, and §What the review found — where its premise was corrected; `stories/placeholder-preserving-actions.md` §Runner and server — the per-step resolution the CLI and the server do and this runner did not (the story the code comments cite; it lives on the `claude/placeholder-preserving-actions` branch, PR #125, and is not on `main`); [stories/project-scoped-data-dir-and-env.md](../../stories/project-scoped-data-dir-and-env.md) — why the Sessions API server composes its env without touching `process.env`
**Opened:** 2026-09-05
**Resolved:** 2026-09-05

## Summary

Any test using `${env.X}` or `${data.x}` run through the Electron Runner UI
sent the reference to the model as literal text. Driving the adapter's
`start()` over a project with `.env.uat` and `data/uat.json`, with the
executor replaced by a spy, this is what the model would have been asked to
do:

```
- Expected
+ Received

  [
-   "Go to https://uat.example.com/login",
-   "Enter admin@uat.example.com in the email field",
-   "Type admin@uat.example.com into the search box",
+   "Go to ${env.BASE_URL}/login",
+   "Enter ${data.user.email} in the email field",
+   "Type ${data.user.email} into the search box",
  ]
```

The third line is the `Set` story's threading at work on nothing: `Set
{{who}} to "${data.user.email}"` was handed no context, so it stored the
reference itself, and `{{who}}` typed it.

The report that opened this said the runner had *regressed*: the parser used
to rewrite `parsed.steps` at parse time, the placeholder-preserving PR turned
that rewrite into a validation, the CLI and the two server loops were taught
to resolve per step, and the Electron adapter was missed. That is the shape
of what happened to the other loops, and it is not what happened here.
Checked against the tree:

1. **The parser only ever resolved `${…}` when the caller handed it a
   context.** `parseTestFile` has gated the whole env/data pass on
   `options.envData` since the commit that introduced it (`22d9dcb`), and
   the adapter's call has been `parseTestFile(filePath, { skillsDir })` —
   no context — since that same commit. So for this runner there was never
   a rewrite to lose: no validation, no `dataSources`, no hook or parameter
   substitution, and `parsedTest.envData` always `undefined`. The Set
   story's own review section already said so ("the threading is correct
   but inert until the surrounding gap is fixed"); its §Still open bullet
   kept the original wording.

2. **The step loop ran only the `{{…}}` pass.** `interpolate(raw,
   resolvedParameters)` at the run loop and again in `steer()`, never
   `interpolateEnvData`. Once the parser hands a context back this is the
   half that has to do the work, per step, in the CLI's order.

3. **`aiui ui --env staging` could not turn any of it on.** The `ui` command
   loaded `.env.staging` into its *own* `process.env` and spawned Electron
   with a copy, so the child had the *values* — but nothing carried the
   *name*: no `--env` argument, no `AUTOMATION_ENV`. The documented way of
   picking an environment for the UI selected one for `loadConfig` and for
   nothing else.

Hooks are unaffected only in the sense that this runner runs none.

## Fix

**The parse gets a context, with the CLI's precedence.** `executeRun` reads
`AUTOMATION_ENV` (run-wide), else the test's own `env:` frontmatter (read
off a first parse, as `aiui run` does), else none. A named environment goes
through `envContextFor` → `resolveEnvBundle({ envName, projectRoot:
process.cwd(), dataDir, mutateProcessEnv: true })`, the same composition as
the CLI: the process environment, base `.env` for anything missing,
`.env.<name>` on top, `data/<name>.json` with its `$VAR` leaves resolved.
`mutateProcessEnv` is deliberate — a `## Parameters` `$VAR` reads
`process.env` directly and `expandTestInstances` gives it no per-run map, so
without it a frontmatter-selected file would reach step text and not the
parameters block. `start()` snapshots `process.env` before the run and puts
it back in its `finally`, so the overlay lasts exactly as long as the run:
the CLI's process exits, this one does not. None selected leaves a `${…}`
as written, which is what
`aiui run` without `--env` does; the fix does not invent base-`.env`
resolution the other runners do not have.

**Per step, env/data then `{{…}}`.** `resolveStepText` is
`interpolate(interpolateEnvData(raw, envData), resolvedParameters)` when
there is a context and the plain `interpolate` when there is not. The run
loop reaches it only after `parseSetStep` has read the authored line, so a
`Set` target is still never substituted; `steer()` reaches it for the
instruction typed at a breakpoint, and a steer whose `${…}` the environment
cannot answer is refused as a `runner:log` error line and not run.

**The context, and the authored line, travel to the executor.** Both
`executeStep` sites now pass `envData` — so the `## Values` block, action
substitution, a code-behind `step.getVar('data.x')` and secret masking read
what the step text did — and the step as authored as the fifth argument, the
CLI's `rawInstruction`. The executor decides what the model sees from the
authored line, not the substituted one: with it the prompt shows `Enter
${env.ADMIN_PASSWORD}` beside a masked Values row and the model names the
placeholder in its action; without it the executor falls back to the
substituted text and the model is shown the password itself.

**`aiui ui --env <name>` forwards the name.** The `ui` command sets
`AUTOMATION_ENV` on the spawned Electron process. One line; it is the
variable `aiui run` already reads when it has no `--env` flag.

**The Set branch's threading went live** without a change of its own.

After, same fixture, same spy:

```
[
  "Go to https://uat.example.com/login",
  "Enter admin@uat.example.com in the email field",
  "Type admin@uat.example.com into the search box",
]
```

## Tests

- [tests/ui-runner-adapter-env-data.test.ts](../../tests/ui-runner-adapter-env-data.test.ts)
  drives `UIRunnerAdapter.start()` with the browser, the step executor and
  the AI client replaced and everything between the file on disk and the
  executor's arguments real — env files, data file, parser, bundle, loop.
  Five cases: frontmatter `env:` (values reach the executor, the panel and
  `process.env` for the run's duration; the authored line is the fifth
  argument; `envData` rides every call; the `Set` template resolves; the
  overlay is gone after); `AUTOMATION_ENV` with no frontmatter (the
  `aiui ui --env` chain); no environment at all (the reference is left as
  written and no `envData` is passed — the CLI's behaviour without `--env`,
  pinned so the fix is not mistaken for base-`.env` resolution); two runs on
  one adapter, pinned then unpinned (the second sees neither the earlier
  values nor a context); and a paused run steered twice, once with a `${…}`
  the environment cannot answer (a log line, no executor call, no
  `runner:error`) and once with one it can (resolved, authored line passed).
- [tests/substitution-sites.test.ts](../../tests/substitution-sites.test.ts):
  `resolveStepText` joins the canary's name list, so a new caller of the
  helper counts; the adapter is classified at five calls — the definition,
  the two raw calls, the two callers.

## What the review found

An Opus review of the first commit, run adversarially and against the
claims above, found two real defects, one silent failure and two
overclaims. Each was reproduced before it was acted on.

1. **The model was shown the resolved secret.** The first cut passed the
   executor four arguments, not the CLI's five. The fifth is the step as
   authored, and it is what the executor's prompt shows beside the Values
   block; without it `authored` defaulted to the substituted text, the
   Values block was always empty (it looks for `${…}` in the authored line),
   and `Enter ${env.ADMIN_PASSWORD}` reached the AI provider as
   `Enter hunter2` — and again in every later step's history. Before the
   fix the same step reached the model as the literal token, so this was
   damage the fix introduced. Fixed: both sites pass the authored line, and
   the test asserts the fifth argument.
2. **The overlay outlived the run, and worse than this file first said.**
   Reproduced against `resolveEnvBundle`: run `uat`, then `prod`, in one
   process — `prod`'s bundle kept `uat`'s value for every key both files and
   the base `.env` shared (the base fills only what the baseline lacks, and
   the baseline was polluted), `${env.ONLY_IN_UAT}` resolved instead of
   throwing, and `loadConfig()`, which re-reads `process.env` per run, would
   have kept a `.env.uat` `AI_MODEL` for the window. Fixed: `start()`
   snapshots `process.env` and restores it when the run ends; the two-runs
   test pins it.
3. **A refused steer vanished.** The new throw rejected the `runner:steer`
   invoke, which the renderer calls without a catch and with no
   `unhandledrejection` handler; the input box cleared and nothing was
   said. Fixed: the refusal is a `runner:log` error line, not `runner:error`
   — that event ends the run in the panel, and the run is still paused
   waiting for a steer that resolves.
4. **The test's reason for leaving out a `Set` was wrong.** It said a Set
   with `${data.…}` and no environment would be refused; it stores the
   literal, as the before-output above shows. Comment corrected.
5. **The canary lost resolution.** Two raw calls on one line of a helper
   meant a third caller of the helper added nothing to the count the canary
   is for. `resolveStepText` is now in the canary's name list, so its
   callers count.

Checked and found true: the diagnosis at 22d9dcb; that this runner runs no
hooks; that the Set threading is live; that a test step cannot reach the
steer refusal, because the parse validates its references first; that the
two-pass parse is no worse than the CLI's; and that the test exercises the
real parse → bundle → loop rather than its mocks.

## Not done here

- **No environment picker in the Runner UI.** The selection is `aiui ui
  --env <name>` or the test's frontmatter, as it was for the values before.
- **`aiui ui --env` forwarding has no test.** One line in a function that
  spawns Electron; the adapter's `AUTOMATION_ENV` case covers the receiving
  end only.
- **The project root is the working directory** for `.env*` and `data/`,
  while uploads and `dataSources` resolve from the test file. `aiui ui
  ../other-project/tests` splits the two. Pre-existing, and the same as
  `aiui run`; the `ui` command's directory argument just makes it easier to
  hit.
- **Not proven in the running Electron app.** `npm run ui` was not launched;
  the test drives the adapter's public entry point with the seams above
  replaced. The code between `start()` and `executeStep` is the code that
  ran.
