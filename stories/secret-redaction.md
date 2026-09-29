# Secrets stay out of what the framework writes

A test that signs in somewhere has a password in it — as a `## Parameters`
entry fed from `.env`, as `${env.GITHUB_PASSWORD}` inline, as a data-file
value, or as something a step captured with `[as: token]`. The run needs the
real value to type it. Nothing the framework *prints or saves* needs it, and
today several of those outputs carry it anyway.

## What we're building

Two outputs of a run show the password in clear text:

**The console.** Every step is announced with its placeholders already filled
in. This is the server's stdout when Steptix drives a run (which the
`steptix serve` terminal shows, and `%LOCALAPPDATA%\steptix\serve-manual.log`
keeps), and the terminal when `steptix run` drives it:

```
[2026-08-23 07:58:35] Step 7/8: Enter the username paul@example.com
[2026-08-23 07:58:38] Step 8/8: Enter the password hunter2!x
```

It is the one log line that ignores the log level — `consoleLogLevel: error`
silences everything else and still prints this — so there is no setting that
hides it.

**The HTML report.** A step that ran under the model keeps its AI turns in the
report: the prompt that was sent, the model's reply, the actions it chose.
All three contain the resolved step text or the typed value, so the report
for a login test has the password in it three or four times:

```
## Current Step
Enter the password hunter2!x
```
```
"Variables captured so far: username = "paul@example.com" password = "hunter2!x""
```
```
{ "type": "type", "selector": "#password", "value": "hunter2!x" }
```

Of the 125 reports in one project, 80 had the GitHub password in them. The
ones that didn't were runs where the login steps executed as code-behind —
no model turn, nothing to record. It hides well: the report HTML-escapes its
text, so a password with an `&` in it is on disk as `&amp;` and a plain
search for the value finds nothing.

After this story, the console says

```
[2026-08-23 07:58:35] Step 7/8: Enter the username paul@example.com
[2026-08-23 07:58:38] Step 8/8: Enter the password ***
```

and the report's turn details say `Enter the password ***` and
`"value": "***"`. The username is still there — it isn't a secret by the
rule below, and seeing resolved values in the console is most of why the
line prints them.

## The rule

The same rule the recording on disk already uses
([codebehind-recording-on-disk.md](codebehind-recording-on-disk.md)), so the
two can't disagree about what a secret is:

- **A secret is named, not guessed.** A value is secret when the *name* it
  came in under matches `password`, `secret`, `token` or `key`
  (case-insensitive, substring) — `isSecretName` in `src/parser/parameters.ts`.
  That covers `## Parameters` entries, `[input: …]` answers, `[as: …]`
  captures, `${env.X}` variables and data-file keys at any depth. The rule
  over-matches on purpose (`keyword`, `monkey`): masking a value that wasn't
  secret costs a little readability; the other direction costs a password.
- **Masking is by value, at the output.** Every occurrence of a secret
  value in the text being written becomes `***`. Longest value first, so a
  secret that contains another is masked whole. Done before HTML-escaping,
  so the `&amp;` case is caught.
- **The run itself is untouched.** The step executes with the real value;
  the action cache stores the real action; a captured `[as: token]` flows to
  the steps after it unchanged; the Sessions API still returns the actions a
  client's run performed, because that client supplied the values.
- **Screenshots are never touched.** They are base64 text, where a short
  secret can match by coincidence; replacing it would corrupt the image, and
  a password typed into a masked field isn't in the picture anyway.

## Where it applies

- **The console step line**, on all three runners that print one: the CLI
  (`src/runner/test-runner.ts`), the Sessions API (`src/server/session-manager.ts`)
  and errands (`src/server/errand-runner.ts`, whose line goes to stderr under
  `steptix mcp` — the host's MCP log).
- **The `TestReport`**, before anything renders or persists it: the HTML
  report, `steptix run`'s end-of-run `FAILED TESTS` summary (which prints the
  failed steps' text), the run-history line appended to the test file, and
  the failure diagnosis prompt. Covered on the CLI, the server (including the
  re-render that adds the video link when a session closes) and the Electron
  runner.
- **The per-run log file** (`serverFileLogLevel: compact|full`): log lines,
  and in `full` mode the AI request/response trace blocks — which are the
  prompt and reply verbatim, the same text the report carries.
- **The recording** — already did this; it now reads the rule from the same
  module as the rest.

## Technical detail

One module, `src/utils/secrets.ts`:

- `secretValues(parameters, extra)` and `redact(text, secrets)` — moved out of
  `src/codebehind/recording.ts`, which re-exports them.
- `runSecrets({ parameters, envData })` — the values this run must never
  print: secret-named parameters plus `envDataSecretValues(envData)`. Taken
  fresh at each use, because the parameter map grows during a run
  (`[as: …]`, `[input: …]`).
- `redactDeep(value, secrets)` — a masked deep copy: every string in every
  plain object and array, by value only (never by key name — the walk sees a
  `press` action's `key: "Enter"`, and the name rule over-matches on
  purpose). Skips `screenshotBase64` / `screenshot` keys and any
  `data:image/` string. `redactReport(report, secrets)` applies it to a
  `TestReport` and masks the `parameters` map by name as well
  (`redactMap`), so a future field is covered without a code change.

The three `logger.step` call sites wrap the instruction in `redact(…,
runSecrets(…))`. The three report builders hand `generateReport` a masked
copy; on the server that copy is also what `pendingVideo` re-renders, and on
the CLI it is what `runTest` returns, so the failure diagnosis (which reads
the live page, where the typed value can still sit in an input) is masked on
its way in. The run-log bridges take a `secrets` getter — read at each
write, because captures add to the list — and mask the log line as text and
the trace payload as an object *before* it is serialized, so a value JSON
would escape (a quote or a backslash in it) is still found.

## What was built

Everything above, on the branch `feat/secret-redaction`. Proof:

- Unit: `tests/secrets.test.ts` (the rule, the walk, the report copy) and
  `tests/run-log-secrets.test.ts` (the file bridges, including the
  JSON-escaped case). At the seams, through the real entry points:
  `tests/api-server-stepmode.test.ts` posts a batch with a `password`
  parameter and one with `${env.GITHUB_PASSWORD}` plus a mid-run capture under
  a secret name — the executor gets the real text, the console line and the
  report get `***`; `tests/api-server-errands.test.ts` the same for an
  errand's line; `tests/test-runner-clarification-control.test.ts` the CLI
  runner, report and diagnosis. Root suite 2804/2804.
- Live, through the worktree's `steptix run` on a scratch project: a
  `password: $PW` parameter whose value contains an `&`, a local form page,
  three steps under the model (41k tokens). The console printed `Step 2/3:
  Type *** into the password field and click Go`; the 259 KB report held the
  value in none of its encodings (raw, HTML-escaped, JSON-escaped) and `***` in
  nine places, the action JSON reading `"value": "***"`; the `full`-mode
  run log, 188 KB with every prompt and reply, likewise none.

Nothing in `steptix-vscode/` or `runner-core/` changed — the extension
sees only a line number on `step:start` and paints the file's own text — so
there is no version bump; the server picks this up on restart.

## What stays as it was

- Step results over the Sessions API (`step:fail` error text, the `actions`
  array) — the client sent the secret and may see what was done with it.
  Redacting the wire would also have to cover `frame:push` and the compile's
  SSE stream; a different story if ever wanted.
- The model's own prose is masked by value only. A reply that paraphrases a
  secret ("I typed the password, which starts with h") is not caught. Nothing
  short of a second model call would be.
- Existing reports are not rewritten. The 80 in `reports/` that carry the
  value keep it until deleted — and so does the server's console log file,
  for the runs made before this.
- The CLI report shows the step as it ran (`Enter the username paul@…`), the
  server's as it was authored (`Enter the username {{username}}`). Two
  conventions that predate this story; it only masks the secret in the
  first.
- `isSecretName` is the one rule. A project that wants `pin` or `otp` masked
  has no knob; a future `secrets:` config list would slot into `runSecrets`.
