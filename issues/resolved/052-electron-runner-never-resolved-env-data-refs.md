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
parameters block. None selected leaves a `${…}` as written, which is what
`aiui run` without `--env` does; the fix does not invent base-`.env`
resolution the other runners do not have.

**Per step, env/data then `{{…}}`.** `resolveStepText` is
`interpolate(interpolateEnvData(raw, envData), resolvedParameters)` when
there is a context and the plain `interpolate` when there is not. The run
loop reaches it only after `parseSetStep` has read the authored line, so a
`Set` target is still never substituted; `steer()` reaches it for the
instruction typed at a breakpoint.

**The context travels to the executor.** Both `executeStep` sites now pass
`envData`, so the `## Values` block, action substitution, a code-behind
`step.getVar('data.x')` and secret masking read what the step text did —
the same option the CLI threads.

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
  Three cases: frontmatter `env:` (values reach the executor, the panel, and
  `process.env`; `envData` rides every call; the `Set` template resolves);
  `AUTOMATION_ENV` with no frontmatter (the `aiui ui --env` chain); and no
  environment at all (the reference is left as written and no `envData` is
  passed — the CLI's behaviour without `--env`, pinned so the fix is not
  mistaken for base-`.env` resolution).
- [tests/substitution-sites.test.ts](../../tests/substitution-sites.test.ts):
  the adapter's two substitution calls are now on one line of
  `resolveStepText`; the classification comment says so and the count is
  unchanged at 2.

## Not done here

- **No environment picker in the Runner UI.** The selection is `aiui ui
  --env <name>` or the test's frontmatter, as it was for the values before.
- **An unknown `${…}` typed into `steer()` now throws** — `interpolateEnvData`
  refuses an unresolvable reference — and the `runner:steer` invoke rejects.
  Before, the text went to the model as written. A test *step* cannot reach
  that: the parse validates its references first.
- **The `process.env` overlay outlives the run.** In one window, a later run
  pinned to a different environment layers over the earlier one; its own
  `.env.<name>` keys win, but a key present only in the earlier file lingers.
  `aiui ui --env` already did this for the whole window, and the CLI does it
  for its single run; the Sessions API server is the one that composes
  without mutating, because it serves many projects at once.
- **Not proven in the running Electron app.** `npm run ui` was not launched;
  the test drives the adapter's public entry point with the seams above
  replaced. The code between `start()` and `executeStep` is the code that
  ran.
