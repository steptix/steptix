# Agent steps: `[use agent]`

**Status:** draft. Reviewed with `/user-journey-review` on 2026-11-24: §5.7,
§5.8 and §6.3 answer four findings, and §15 records the rest.
**Opened:** 2026-11-24

## 1. What this is

`[use agent] <goal>` is a step that works towards a goal over many turns,
instead of carrying out one instruction. The author says what to achieve and
how to tell it is finished; Steptix runs a loop until the model says it is
done or that it is stuck.

Each turn the model sees the goal, what the current surface shows (the DOM
snapshot in browser mode, the screenshot in computer mode), a short history
of its own turns, and the actions it may take. It answers with ONE action;
Steptix performs it and starts the next turn. The actions are:

- **the current surface's actions** — the same ones an ordinary step has
  (click, type, navigate, … or the computer mode set);
- **project tools** — the tools in `toolsDir`, called by name with arguments;
- **files and commands**, when the project turns them on (§6) — read, write
  and list files in the workspace, and run commands, so the model can write
  a script, install what it needs (`npm install`, `pip install`) and run it;
- **agent skills** (§7) — instructions in the open Agent Skills format,
  loaded when the model decides it needs one;
- **`done`** with the values to store, or **`stuck`** with the reason.

`[use ai]` is the nearest existing step and the contrast is the point:
`[use ai]` asks the model once, with nothing but the step's words. `[use
agent]` gives the model the page, tools and a machine to work on, and many
turns.

The directive scopes three ways (§5.6): one step (`[use agent] <goal>`), a
`### Section` (a bare `[use agent]` as its first step), or a whole file
(`agent: on` in the frontmatter). In a scope, every plain step runs as an
agent step.

## 2. Why

Two kinds of step that ordinary steps cannot express:

- **A path the author cannot write down in advance.** A wizard whose pages
  depend on account settings, a desktop dialog that fills in differently each
  time. Writing a branch for every variant makes the test longer than the
  feature and breaks when the app changes.
- **Work outside the page.** Converting a downloaded file, reading a PDF,
  generating test data, calling an API to check what the UI claims. Today
  each of these needs a project tool written in advance; a general agent
  (Copilot, Claude Code) does it by writing a script and running it.

## 3. Non-goals

- **MCP servers.** The agent cannot call MCP servers. Steptix's own MCP server
  is unaffected.
- **Compiling an agent step.** It never becomes code-behind. The model
  answers on every run; compile leaves the step as AI and says so (§9).
- **Switching surface inside the step.** An agent step runs on the surface it
  starts on. A test that needs both writes `[use computer]` between two steps.
- **A sandbox.** Steptix limits what the agent is offered, not what a script
  does once it runs (§6.6).
- **Native tool calling.** The model answers in Steptix's JSON action format,
  which works on every route, the Copilot bridge included.

## 4. What an author can write

Every name below is invented. Steps that check a result are ordinary steps
after the agent step: the agent gets there, the checks decide (§5.4).

### 4.1 Download a CSV report and save it as Excel

```markdown
## Config
- baseUrl: https://tallybook.test/

## Steps
1. Navigate to the Reports page
2. [use agent] Download the March orders report as CSV, then convert it to an
   Excel file named orders.xlsx in the exports folder, installing whatever
   library you need. You are done when orders.xlsx exists and has the same
   number of data rows as the CSV; store its path in report_xlsx and the row
   count in report_rows.
3. Verify the Reports page shows {{report_rows}} orders for March
```

`exports` is a folder the project allows the agent to write to
(`agent.folders`, §6.2). One run might go like this: download the file,
write `convert.py`, create a virtual environment, `pip install openpyxl`,
run the script, count the rows, answer `done`. Another model may write a
Node script and `npm install` a different library; both pass the same check.

### 4.2 A wizard whose pages vary

```markdown
3. [use agent] Export every March order for Harbour Supplies as CSV. Answer
   whatever the export wizard asks and choose CSV whenever it offers a format.
   You are done when the download has finished; store its path in export_file.
   If the app says the export will be emailed instead, you are stuck.
4. [tool: csv_row_count file="{{export_file}}" out.rows="exported_rows"]
```

### 4.3 Make test data, then use it

```markdown
2. [use agent] Write a CSV file of 25 invented customers with the columns
   name, email and city. Every email must be unique. Store its path in
   customers_csv.
3. Upload {{customers_csv}} using the Choose file button on the Import page
4. Verify the Import page says 25 customers were added
```

### 4.4 Read a downloaded PDF

```markdown
5. [use agent] Read the invoice PDF at {{invoice_pdf}} and store the amount on
   its Total line in invoice_total, exactly as printed.
6. Verify the Total on the Invoice page reads {{invoice_total}}
```

### 4.5 Check the back end behind the UI

```markdown
## Parameters
- api_token: ${env.ORDERS_API_TOKEN}

## Steps
4. [use agent] Call GET {{api_url}}/orders?customer=Ada, authenticating with
   the bearer token in api_token, and store how many orders it returns in
   api_orders.
5. Verify the Orders page lists {{api_orders}} orders for Ada
```

The model never sees the token's value: it is masked in the prompt, and the
script reads it from an environment variable (§6.4).

### 4.6 A desktop application

```markdown
6. [use computer]
7. Focus the window whose title contains "Stockroom"
8. [use agent] Import {{export_file}} through File > Import orders, accepting
   the column mapping it proposes. You are done when Stockroom shows its import
   summary; store the number of orders it says it imported in imported_rows.
9. Verify {{imported_rows}} equals {{exported_rows}}
```

### 4.7 With an agent skill

```markdown
3. [use agent] Using the ledger-export skill, export the March ledger for
   Harbour Supplies and store the file's path in ledger_file.
```

`.agents/skills/ledger-export/SKILL.md` in the project:

```markdown
---
name: ledger-export
description: How to export a ledger from Tallybook, including the pages its export wizard can show.
---
The export wizard can show up to four pages, in this order: date range,
customer, currency (multi-currency accounts only), format. ...
```

The model sees the skill's name and description every turn and loads the rest
when it needs it. Naming the skill in the step is optional.

### 4.8 A section of agent steps

```markdown
## Steps
1. Sign in
2. Export the March ledger
3. [tool: csv_row_count file="{{ledger_file}}" out.rows="ledger_rows"]
4. Verify the Ledger page shows {{ledger_rows}} entries

### Export the March ledger
1. [use agent]
2. Open the export wizard from the Ledger page
3. Answer whatever the wizard asks for March and Harbour Supplies, choosing
   CSV whenever it offers a format
4. Once the download has finished, store the file's path in ledger_file

### Sign in
1. Enter {{accounts_user}} in the Email field
2. Enter {{accounts_password}} in the Password field
3. Click Sign in
```

Steps 2 to 4 of *Export the March ledger* each run as an agent step. *Sign
in* and the main flow run as ordinary steps.

### 4.9 A whole file

```markdown
---
agent: on
---

# Month-end smoke check

## Steps
1. Navigate to the Orders page
2. Close the "What's new" panel if it is showing
3. Export the March orders as CSV and store the file's path in export_file
4. Convert {{export_file}} to an Excel file in the exports folder and store
   its path in export_xlsx
5. [tool: xlsx_row_count file="{{export_xlsx}}" out.rows="xlsx_rows"]
6. [no-agent] Verify the Orders page shows {{xlsx_rows}} orders for March
```

Steps 1 to 4 are agent steps. Step 5 keeps its own grammar, and step 6 is
opted out so the check is an ordinary `Verify` (§5.6).

### 4.10 What not to write

`[use agent] Test the checkout` has no finished state, so the model can only
guess when it is done. The prompt tells the model that a goal with no way to
tell it is finished is `stuck`. Agent steps also cost a model call per turn on
every run, so a path the author knows belongs in ordinary steps, which are
cheaper and compile.

## 5. The step

### 5.1 Grammar

`[use agent]` at the start of a step, then the goal. Same rules as `[use ai]`:
case-insensitive, `[no-hooks]` stripped first, matched against the step as
authored, before `{{…}}` interpolation. Added to `src/parser/use-step.ts` and
its `runner-core` mirror; `tests/use-step-parity.test.ts` keeps them equal. A
failure tail (`otherwise continue …`) works as on any step.

Two more forms, for scope (§5.6):

- **Bare `[use agent]`**, with nothing after it, is allowed only as the FIRST
  step of a block: the main flow of `## Steps`, or a `### Section` body.
  Anywhere else it is a parse error naming the line, since a bare directive
  halfway down a block reads as a switch that this design does not have.
- **`[no-agent]`** at the start of a step, beside `[no-hooks]` and in either
  order, opts that one step out of a scope. Outside a scope it is a no-op
  with a warning.

A file sets file scope with `agent: on` in its frontmatter
(`src/parser/frontmatter.ts`).

### 5.2 The answer

One action per turn, in the existing action format, plus:

| Action | Fields | Meaning |
| --- | --- | --- |
| `done` | `values: [{as, value}]` | Finished. Each value is stored as a variable, as `[use ai]` stores its one. |
| `stuck` | `reason` | Cannot finish. The step fails with the reason. |
| `tool` | `name`, `args` | Call a project tool. |
| `read_file`, `write_file`, `list_dir` | `path`, `content` | Files in the workspace and allowed folders (§6.2). |
| `run` | `command`, `timeoutMs?` | Run a command (§6.3). |
| `load_skill` | `name` | Add an agent skill's instructions to the context (§7). |

`read_file`, `write_file`, `list_dir` and `run` exist only when `agent.shell`
is on. `read_file` takes an optional `offset`, so the model can read past
what one result shows (§5.5).

Any answer may also carry `notes`, which replaces the step's notes (§5.5).

### 5.3 How it ends

| Ending | Step result |
| --- | --- |
| `done` | Passes; values stored. |
| `stuck` | Fails with the model's reason. |
| `agent.maxTurns` reached | Fails: "did not finish in N turns". |
| `agent.timeout` reached | Fails, naming the limit. |
| The same action on an unchanged observation 3 times | Fails as stuck, naming the repeated action. |
| Stop or Cancel | Stops at once: the model request is aborted and every process the step started is killed (§6.5). |

An unanswerable or malformed reply is retried within `execution.retries`, as
for an ordinary step. Every failure in this table also lists the refusals of
§5.8.

### 5.4 `done` is a claim

Steptix does not check the model's `done`. That is the author's job, in the
steps after it, with `Verify` steps and tools that need no autonomy. The
examples in §4 all do this, and the docs say why: an agent cannot talk a test
into passing if the checks are not its own.

### 5.5 Context over many turns

**Each turn is one fresh request, rebuilt from the step's state.** It is not
a chat that grows by a message per turn. That is how multi-turn steps work
today: every turn sends a system message and one user message built from
what the step has done so far (`src/runner/step-executor.ts`, the
`buildStepMessage` / `buildContinuationMessage` call before `messages`).
Keeping that shape means Steptix decides exactly what the model sees each
turn, trimming is a choice of what to render rather than an edit to a
history, it works the same on every provider and over the Copilot bridge,
and masking is applied once, when the request is rendered.

**What a turn's request holds, in order.** The parts that do not change come
first, so a provider that caches a request's prefix can reuse it from turn to
turn:

| # | Part | Changes |
| --- | --- | --- |
| 1 | System prompt: the agent's rules, the surface's actions, the shell and runtimes on this machine (§6.3) | Never in a run |
| 2 | Catalogue: the project tools with their parameters, and the agent skills' names and descriptions | Never in a run |
| 3 | Prior steps: one line per earlier step, as ordinary steps get them (`formatStepHistoryEntry`), masked | Never in a step |
| 4 | The goal: the step as authored, its masked `## Values`, the workspace and the allowed folders | Never in a step |
| 5 | Loaded skills: the full text of each skill loaded so far, in the order loaded | Appended to |
| 6 | Turn log: one line per finished turn, its action and a short result, e.g. `3. run python -m venv .venv → exit 0 (4.8 s)`. Refusals are logged the same way. A line is written once, when its turn ends, and never rewritten | Appended to |
| 7 | Notes: what the model asked to keep (below) | Any turn |
| 8 | Recent results: the full result of the last `agent.historyTurns` turns (default 4): command output, file contents read, tool outputs, folder listings, errors | Every turn |
| 9 | Now: the current DOM snapshot, or the current screenshot in computer mode, and *Turn 8 of at most 30, 4 min 10 s left* | Every turn |

**What falls away.** An older turn keeps its line in the log but loses its
full result. An older observation is never sent again; only the current one
is. A loaded skill is never dropped, which is why skills are loaded rather
than all sent up front.

**Notes.** Since older results fall away, any answer may carry `notes`: a
short text, at most 2,000 characters, that replaces the step's notes and is
sent on every later turn of the step. It is how the model keeps a fact it
found early (say, which menu the export sits under) once the turn that found
it has left the recent results. The notes are shown in the report with each
turn.

**What one result may cost.** Command output and file contents sent back to
the model are cut to `agent.resultMaxChars` (default 8,000): the first and
last halves, with a line saying how much was left out. The model can read
more of a file or a log with `read_file`, which takes an offset. The report
keeps the full text either way (§8.5).

**Masking.** Every part is rendered through the run's secret masking
(`redact` with `secretsNow()`), the same as the prior-steps lines are today.
That includes command output and file contents, so a script that prints a
secret it was given (§6.4) does not hand it to the model.

**When it grows too big.** A request is measured before it is sent, and kept
under `agent.maxContextTokens` (default 100,000). Over it, Steptix shrinks it
in this order and logs what it did:

1. fewer turns in *Recent results*, down to the last one;
2. `resultMaxChars` halved for this request;
3. the oldest turn-log lines folded into one line, *Turns 1–12: 12 actions
   (see notes)*. This changes the request's prefix once, which a cache will
   miss on that turn.

If the fixed parts (1 to 5) alone are over the limit, the step fails before
the turn, naming the largest part and the setting. A skill too big to load
fails the `load_skill` with its size instead, and the model is told.

**Between steps.** Each agent step starts with an empty turn log, empty
notes and no recent results. What reaches it from the steps before is what
reaches any step: the page as it is, the variables set, the files in the
workspace, and the prior-steps lines. An agent step in a scope is no
different from one alone; open question 5 asks whether a section should
share one log.

**These numbers are starting points.** `historyTurns`, `resultMaxChars` and
`maxContextTokens` are guesses until live runs show how many turns models
take and how often they need an older result again. §12's live tests
measure them.

### 5.6 Scope: a section or a whole file

| Written as | Scope |
| --- | --- |
| `[use agent] <goal>` | That step. |
| `1. [use agent]` as a section body's first step | The rest of that section's body. |
| `1. [use agent]` as the main flow's first step | The rest of the main flow, not its sections. |
| `agent: on` in the frontmatter | Every block in the file: the main flow and every section. |

In a scope, every **plain** step runs as an agent step, its text the goal,
with the endings of §5.3. Lines the parser already claims keep their meaning
and are never agent steps: `Set`, `[tool: …]`, `[use ai]`, `[skill: …]`,
`[input: …]`, `[interactive]`, `[use computer]` / `[use browser]`,
control-flow lines, and section calls. `[no-agent]` opts out one plain step.

Steptix never decides from a step's wording whether it is a check, so a
`Verify …` step in a scope is an agent step too. A check that should be an
ordinary `Verify` is marked `[no-agent]`, as §4.9 does, and the docs say so.

**Scope is lexical.** A block's scope comes from its own text and its file's
frontmatter, never from the caller. An ordinary section called from an
agent-scoped main flow runs its steps as ordinary steps, and an agent-scoped
section called from an ordinary flow runs its steps as agent steps. A
`[skill: …]` file is a file of its own: its frontmatter decides, and the
caller's does not carry in. So a reader can tell which steps are agent
steps from the file alone, and the editor can paint them before a run.

**Scope does not touch the surface.** An agent scope runs on whatever surface
the session is on, and `[use computer]` inside it switches surface as it
always does (`SPEC-use-computer` §4.5). The surface is session state that
outlives a block; agent scope ends with the block.

**`## Hooks` are outside every scope.** Hooks are not under `## Steps`, so
`agent: on` does not reach them.

**Showing it.** The editor marks every step that will run as an agent step,
whatever made it one, and the report labels it the same way, so the file,
the editor and the report never disagree about which steps used the agent.

### 5.7 Every way of running a step keeps its scope

A step's scope is read from the file's text, never from what else happens to
be in the batch. That matters because most runs send only part of a file:
Run From Here starts below the bare `[use agent]`, and a section body line
run on its own reaches the server as a step at the root, with no enclosing
section (`runner-core/src/api-client.ts` `detachedBody`).

- **One rule, two copies.** `agentScopeOf(text)` returns the lines that run
  as agent steps. It lives in `runner-core/src/step-lines.ts` beside
  `extractSteps`, with an import-free copy in `src/parser/` for the CLI and
  for MCP's `run_test_file`, which read the file themselves. A parity test
  keeps the two equal, as `tests/use-step-parity.test.ts` does for the
  grammar. The editor's marks (§5.6) come from the same function.
- **On the wire.** `StepRequest.agent` says which steps of the batch are
  agent steps: `{ file?: true, steps?: number[] }`. `file` is set when the
  frontmatter says `agent: on`, and covers every plain step in `steps` and
  every body in `sections`. `steps` lists positions in `steps` that are agent
  steps because their block opens with a bare `[use agent]`. A section body
  in `sections` carries its own first line, so the server reads its scope
  from that. A step whose text starts `[use agent]` needs neither field.
- **Every entry point sends it:** Run, Run From Here, Run Step Here, a
  selection, Run & Compile, each row of a row loop, Continue and the step
  commands after a pause, F11 into a section, and a section line run on its
  own. The rule is the same for all of them because the answer comes from
  the step's line in the file, not from the batch.
- **Raw steps have no file.** Steps posted straight to the Sessions API, and
  MCP's `run_steps`, are agent steps only when their text starts `[use
  agent]`, or when a Sessions API caller sets `agent` itself.
- **The bare line on its own.** Running the `[use agent]` line by itself does
  nothing, with a log line saying the scope it opens applies to the steps
  below it.

### 5.8 A failure names the setting that stopped it

The model's `stuck` reason is in its own words, and may not say that Steptix
refused something. So Steptix records every refusal of its own during the
step, and when the step fails it adds them after the reason, each with the
setting that decides it:

| Refusal | Named in the failure |
| --- | --- |
| A file or command action while `agent.shell` is off | `agent.shell` |
| A command not in the allow list, with nobody to ask | `agent.allowCommands` |
| A command the person denied | "you denied it", and `agent.allowCommands` |
| A question nobody answered | `agent.approvalTimeoutMs`, and `agent.allowCommands` |
| A global install | That packages install into the workspace only (no setting) |
| A path outside the workspace and `agent.folders` | `agent.folders` |
| A command that ran out of time | `agent.commandTimeoutMs` |
| The turn cap or the time limit | `agent.maxTurns` or `agent.timeout`, and the test's `## Config` when it lowered them |

For example:

```
✗ Step 2 stuck: I could not convert the file because the install failed.
  Steptix refused 1 action in this step:
  - pip install openpyxl: not in agent.allowCommands, and this run had
    nobody to ask (CLI). Add "pip install *" to agent.allowCommands in
    steptix.config.json to allow it.
```

When `agent.shell` is off and the step fails with no refusal recorded, the
failure ends with *Files and commands are off for this project
(agent.shell).* as a plain fact, since the model may have given up without
trying. A step that passes despite refusals lists them in the report as
warnings. Each refusal is also sent back to the model when it happens,
naming the same setting, so it can stop early rather than spend its turns.

## 6. Files and commands

### 6.1 Off by default

`agent.shell` in `steptix.config.json`, default false. A project setting and
not a test setting, for the reason `desktop.enabled` is: a test file in a
shared repository must not be able to run commands on a machine whose owner
did not allow it. With it off, an agent step still has the surface actions,
project tools and skills.

### 6.2 The workspace

Each run gets an empty folder, `.steptix/agent/<run id>/` under the project,
shared by every agent step in the run, so a script one step writes is there
for the next. Commands run with it as their working folder. `read_file`,
`write_file` and `list_dir` reach the workspace and the folders in
`agent.folders`, and nothing else. The folder is removed when the run ends,
unless `agent.keepWorkspace` is on; everything the agent wrote is in the
report either way (§8).

### 6.3 Commands

A command runs in the platform shell: PowerShell (`-NoProfile
-NonInteractive`) on Windows, `/bin/sh` on Linux and macOS. The first agent
turn of a run tells the model which shell it has and which of `node`,
`python3`, `python` and `py` are on the path; Node always is, since Steptix
runs on it.

**Which commands run.** A command matching a pattern in
`agent.allowCommands` runs. Any other command is asked about if someone can
answer, and refused if not. A refused command is reported back to the model
with the reason, and recorded for §5.8.

**Who can answer.** Only the VS Code extension, for a run a person started.
Every batch it sends for such a run carries `StepRequest.canApprove: true`.
Nothing else sets it, so the CLI, CI, MCP and raw Sessions API callers never
get a question; for them the allow list is the whole answer. There are two
more cases where no question is asked even then:

- **In computer mode.** The question would appear on the screen the agent is
  driving and reading, where the agent could click it. Computer mode uses the
  allow list only.
- **After a question went unanswered** (below). The rest of that run uses the
  allow list only.

**The question.** The server emits `agent:awaiting-approval` with a
`requestId`, the command, its folder, the step's line, the pattern a "for
this run" answer would cover, and when the question expires. The extension
shows it as a QuickPick that stays open when focus moves (`ignoreFocusOut`),
because a notification can slide out of sight:

```
┌ Steptix agent wants to run a command (52 s) ──────────────────────┐
│ python convert.py orders.csv orders.xlsx                          │
│ in .steptix/agent/run-7 · step 2 of month-end.md                  │
├───────────────────────────────────────────────────────────────────┤
│ > Allow once                                                      │
│   Allow "python *" for the rest of this run                       │
│   Deny once                                                       │
│   Deny "python *" for the rest of this run                        │
└───────────────────────────────────────────────────────────────────┘
```

While it is open, the step's line in the editor and in the run panel shows
*Waiting for your approval*, and both clear when it closes. The answer goes
back as `POST /sessions/:id/agent-approval` with the `requestId`.

**How it closes.** In every case the server emits `agent:approval-closed`
with the reason, the extension hides the QuickPick, and an answer that
arrives later is ignored (the server answers 409 for a `requestId` no longer
pending):

| What happens | Counts as | Then |
| --- | --- | --- |
| An answer | That answer | — |
| No answer in `agent.approvalTimeoutMs` (default 60000) | Deny once | No more questions this run. The report and the run panel say so once. |
| Stop, Cancel, or the step or run ends | Deny once | The work stops (§6.5). |
| The window that started the run closes | Deny once | As for Stop. |

One question at a time: the next command waits for the open question to
close. A run's question goes only to the window that started it, never to
another window.

**Remembering for the run.** "For the rest of this run" lasts until the run
ends: across later rows of a row loop, later agent steps, and a Continue
after a breakpoint. A batch that starts a new run (`runStart`) starts with
nothing remembered. So an agent step in a `For each` over 20 rows asks at
most once per pattern, not once per row. The pattern is the program, plus
its subcommand when the second word is a plain word with no path, dot or
leading dash (`npm install *`, `pip install *`, `python *`). It is shown in
the question so the person sees exactly what they are allowing. An answer is
never written into `steptix.config.json`: allowing a command for good means
adding it to `agent.allowCommands`, which a failure says (§5.8).

Packages install into the workspace, never globally. Steptix refuses
`npm install -g` and `--global`, and runs every command with
`PIP_REQUIRE_VIRTUALENV=1`, so `pip install` works only inside a virtual
environment, which the prompt tells the model to create in the workspace.

Each command has `agent.commandTimeoutMs` (default 120000). Output fed back
to the model is capped; the report keeps it in full.

### 6.4 What a command can see

Commands get a scrubbed environment: the variables the platform needs to run
programs (`PATH`, the home and temp folders, `SystemRoot` on Windows) and
nothing else. Steptix's own keys (`STEPTIX_SERVER_API_KEY`, `AI_API_KEY`)
never reach a script.

A secret the step mentions is masked in the prompt as everywhere else, and
handed to commands as an environment variable named after it
(`STEPTIX_SECRET_API_TOKEN` for `api_token`). The prompt tells the model the
name, never the value, so a script can use a token the model never saw.

### 6.5 Stopping

Steptix kills the whole process tree a command started, not only the shell:
`taskkill /T /F` on Windows, the process group on Linux and macOS. That
happens on a command timeout, on Stop and Cancel, and when the step ends for
any reason.

### 6.6 The limit

A running script can do whatever the user account can. The allow list
decides which commands start, not what they do, and the agent reads the
page under test, whose text can try to steer it. So the docs say plainly:
turn `agent.shell` on only for sites you control, or run Steptix in a
container or VM.

## 7. Agent skills

Instructions in the open [Agent Skills](https://agentskills.io) format: a
folder with a `SKILL.md` whose frontmatter has `name` and `description`.
These are not Steptix skills — the step macros in `skillsDir` that a test
calls with `[skill: …]` — and they live in their own folder,
`agent.skillsDir`, default `.agents/skills` under the project.

- **Project only.** Never `~/.agents`, `~/.claude` or anywhere else on the
  machine, so a test behaves the same on every machine.
- **Discovery.** At the first agent step of a run, each `SKILL.md` is parsed;
  one with no description is skipped with a warning. Every agent turn lists
  the names and descriptions.
- **Loading.** `load_skill` adds the skill's body to the context. Its other
  files are readable with `read_file` when `agent.shell` is on, and its
  scripts run only through `run`, under §6.
- **None at all.** With no skills folder, the prompt says nothing about
  skills.

## 8. Report and scoreboard

An agent step can take thirty turns, write files and run commands, so the
report shows it in three layers: a header that says how it went, a list of
what it did with one line per turn, and each turn in full when opened. The
existing report pieces (the AI request block, the DOM after an action, the
computer-mode frame with its click ring, the tool block) are reused for the
turns. What is new is the summary, the files and commands, the approvals and
the refusals.

### 8.1 Mockup

The §4.1 step, collapsed:

```
✓ Step 2  [AGENT]  Download the March orders report as CSV, then convert…   41.2 s
          Done in 7 turns · 3 commands · 2 files · 18,430 tokens · $0.06
```

Opened:

```
✓ Step 2  [AGENT]  Download the March orders report as CSV, then convert…   41.2 s
  Done in 7 turns · 3 commands · 2 files · 18,430 tokens · $0.06

  Stored
    report_xlsx  = exports/orders.xlsx
    report_rows  = 120

  What it did
    ▸ 1  click "Download CSV"                          download orders.csv     2.1 s
    ▸ 2  write_file convert.py                         23 lines                0.0 s
    ▸ 3  run python -m venv .venv                      exit 0 · allow list     4.8 s
    ▸ 4  run .venv/Scripts/pip install openpyxl        exit 0 · you allowed    9.6 s
                                                       "pip install *" for this run
    ▸ 5  run .venv/Scripts/python convert.py           exit 0 · allow list     1.3 s
    ▸ 6  list_dir exports                              orders.xlsx (14 KB)     0.0 s
    ▸ 7  done                                          2 values                0.0 s

  Files
    convert.py           23 lines   workspace     [show] [open copy]
    exports/orders.xlsx  14 KB      exports       [open copy]

  Commands  3 run · 0 refused
  Skills    none loaded
```

Turn 4 opened:

```
    ▾ 4  run .venv/Scripts/pip install openpyxl          exit 0 · 9.6 s
         Folder    .steptix/agent/run-7
         Approval  asked at 10:42:13, "Allow pip install * for the rest of this run"
         Output    Collecting openpyxl … Successfully installed openpyxl-3.1.5
                   (2.1 KB, shown in full)
         ▸ AI — agent turn 4 · model · 2,610 tokens      (the request and reply)
```

A stuck step puts the reason and the §5.8 refusals where *Stored* is, in the
failure block every failed step has:

```
✗ Step 2  [AGENT]  Download the March orders report as CSV, then convert…   23.9 s
  Stuck after 5 turns · 2 commands · 1 refused · 9,870 tokens · $0.03

  I could not convert the file because the install failed.
  Steptix refused 1 action in this step:
  - pip install openpyxl: not in agent.allowCommands, and this run had
    nobody to ask (CLI). Add "pip install *" to agent.allowCommands in
    steptix.config.json to allow it.
```

### 8.2 The header

- **The badge** says the step ran as an agent step, and its tooltip says why:
  the `[use agent]` prefix, the section that opens with `[use agent]` (named),
  or the file's `agent: on`.
- **The summary line**: how it ended (§5.3), the turns, the commands run and
  refused, the files written, tokens and cost, and over the Copilot bridge the
  number of premium requests.
- **Context**, on the step's tooltip: the size of the largest request in
  tokens, how much of it the provider reported as cached, and any shrinking
  §5.5 did. Each turn's AI block already shows the exact request, so an
  author can see what the model saw on any turn.

### 8.3 The body

| Part | Shows |
| --- | --- |
| **Stored** | Each value from `done`, masked like any other stored value. Absent on failure, where the failure block (reason, refusals) takes its place. |
| **What it did** | One line per turn: the action in a few words, its result in a few words, its duration. Each line opens to the full turn (§8.4). |
| **Files** | Every file the agent created or changed, in the workspace or an allowed folder: path, size, where it is, and a link to the copy kept beside the report (§8.5). A text file can be shown inline. |
| **Commands** | The count run and refused. Each command is a line in *What it did*, with its exit code and how it was allowed: the allow list, the person's answer and when, or refused and why. |
| **Skills** | The agent skills it loaded, by name and path. |
| **Refusals** | On a step that passed, the §5.8 refusals, as warnings. |

### 8.4 One turn, opened

- **The AI block**, as every AI step has: the request sent (masked), the
  reply, the model and the tokens. The DOM snapshot or screenshot the model
  was shown is inside the request, as now.
- **The action**, by kind:
  - a surface action: the existing sub-action block, with the DOM after the
    action, or the computer frame with its click ring;
  - `tool`: the existing tool block, with arguments, outputs and logs;
  - `write_file`: the path and the content;
  - `read_file` and `list_dir`: the path and what came back;
  - `run`: the command, the folder, how it was allowed, the exit code, the
    duration and the output;
  - `load_skill`: the skill's name and path;
  - `done` or `stuck`: the values or the reason.

### 8.5 Files kept beside the report

The workspace is removed when the run ends (§6.2), so the report keeps its
own copies, in a folder beside the HTML named like the session video is:
`<report base name>-agent/`. In it:

- a copy of every file the agent wrote, text or binary, up to
  `agent.reportFileMaxBytes` (default 10 MB) per file; a bigger one is listed
  with its size and not copied;
- each command's full output, as a `.log` file per command;
- nothing from installed packages (`node_modules`, `.venv`), which would
  dwarf the rest.

Text in the HTML and in these copies is masked the same way as the rest of
the report. Inline, a command's output is shown in full up to 20 KB; above
that the first and last 10 KB are shown with a line saying how much was cut,
and *open full log* links to the copy.

### 8.6 Scope in the report

Every agent step in a scope is its own step in the report, with its own
header (§8.2), whatever made it one. A section scoped to the agent shows one
agent step per body line, and the section's call row adds a total, such as
*3 agent steps · 19 turns*. A step that is not an agent step looks as it
does today, with one addition: a `[no-agent]` step in a scope carries a small
*opted out* marker, so a reader of an agent file can see why that step is
different.

### 8.7 A whole file with `agent: on`

The §4.9 file, run once, with its `[no-agent]` check failing. The report's
header, top to bottom:

```
Month-end smoke check                                            ✗ FAILED
Status Failed · Date 24 Nov 2026 10:41 · Duration 2 min 58 s · AI Model openai/…
Test file  tests/month-end.md

┌ AGENT: ON ────────────────────────────────────────────────────────────────┐
│ This file runs every plain step as an agent step: 4 of its 6 steps did.    │
│ Agent steps never compile, so every run of this file asks the model.       │
└────────────────────────────────────────────────────────────────────────────┘

 6 Steps │ 5 Passed │ 1 Failed │ 4 Agent │ 31 Turns │ 5 Commands │ 0 Refused │ 64,210 tokens

Agent steps                         Ended            Turns  Commands  Tokens   Cost   Time
  Step 4  Convert {{export_file}}…  done                19         5  38,900  $0.13  71.0 s
  Step 3  Export the March orders…  done                 9         0  17,240  $0.06  38.0 s
  Step 1  Navigate to the Orders…   done                 2         0   5,120  $0.01   3.1 s
  Step 2  Close the "What's new"…   done                 1         0   2,950  $0.01   1.2 s

Approvals this run
  pip install *   allowed for the rest of this run · at step 4 · 10:42:13

Files the agent wrote this run
  convert.py             workspace   step 4   [show] [open copy]
  exports/orders.xlsx    exports     step 4   [open copy]
```

Then the steps, collapsed, a failed step open as today:

```
✓ Step 1  [AGENT]  Navigate to the Orders page                      done · 2 turns    3.1 s
✓ Step 2  [AGENT]  Close the "What's new" panel if it is showing    done · 1 turn     1.2 s
✓ Step 3  [AGENT]  Export the March orders as CSV and store…        done · 9 turns   38.0 s
✓ Step 4  [AGENT]  Convert {{export_file}} to an Excel file in…     done · 19 turns  71.0 s
✓ Step 5           [tool: xlsx_row_count …]                                           0.2 s
✗ Step 6  opted out  Verify the Orders page shows 120 orders for March              4.4 s
          Expected 120 orders for March; the page shows 118.
```

What each part is for:

- **The banner** says the whole file is in scope, how many steps that made
  agent steps, and that the file never compiles. That last line is what
  explains why a run of this file always costs tokens, where a compiled
  file's runs cost none.
- **The summary bar** gains *Agent*, *Turns*, *Commands* and *Refused*, shown
  only when the run had an agent step, as *Skipped* and *Tolerated* are
  shown only when there are some.
- **The agent steps table** lists every agent step, most expensive first, so
  the step that took most turns, tokens or time is the first thing a reader
  sees. Each row links to its step.
- **Approvals this run** lists each "for the rest of this run" answer with its
  pattern, the step it was given at and the time, plus any question nobody
  answered. It is the record of what the person allowed.
- **Files the agent wrote this run** is the union of every step's *Files*
  (§8.3), with the step that wrote each, since the workspace is shared by the
  whole run (§6.2).
- **Each step** opens to §8.1's layout. Its badge's tooltip says *agent: on
  in this file*.

The same header appears, scaled down, for any run with an agent step: the
banner only for `agent: on`, the rest whenever there is at least one agent
step. A data-driven run, which writes one report for all its rows, counts
across rows, lists approvals once for the run, and shows each row's agent
steps under that row as it does for any step today.

### 8.8 While it runs

The run panel shows the same header as the step runs, with the turn count
and the current action updating each turn, the *What it did* lines appearing
as they happen, and *Waiting for your approval* during a question (§6.3). The
panel and the finished report show the same lines, so neither contradicts
the other.

### 8.9 Size

Turns add no snapshots beyond what an ordinary step's actions already
record: the DOM after an action follows the existing report settings, and a
computer-mode frame follows `desktop.reportScreenshots`. The model's own view
is in the request block, as for any step.

### 8.10 Scoreboard

Each action is a scoreboard line, tagged as an agent turn, with the step
text, the turn, the action kind and its outcome.

## 9. Code-behind, keyless runs and providers

- **Compile** leaves an agent step as an AI step and says so in its output,
  as it does for `[use ai]`. In an agent scope that means every plain step,
  so an `agent: on` file compiles only its `[no-agent]` steps.
- **A keyless run** fails an agent step with the existing "AI is not
  configured" message, before any turn.
- **Providers.** The JSON action format works on every route. Over the
  Copilot bridge, every turn is a premium request; the report shows the count.
  An agent step in computer mode refuses a route that would drop the
  screenshot, as computer mode does (SPEC-use-computer §15.4).

## 10. Config

```json
"agent": {
  "maxTurns": 30,
  "timeout": 600000,
  "historyTurns": 4,
  "resultMaxChars": 8000,
  "maxContextTokens": 100000,
  "shell": false,
  "allowCommands": ["node *", "npm install *", "npx *",
                    "python *", "python3 *", "py *", "pip install *"],
  "commandTimeoutMs": 120000,
  "approvalTimeoutMs": 60000,
  "reportFileMaxBytes": 10485760,
  "folders": [],
  "keepWorkspace": false,
  "skillsDir": ".agents/skills"
}
```

All project-level. A test may lower `maxTurns` and `timeout` in its
`## Config`; it cannot raise them or change the rest.

## 11. Depends on

**Download handling.** §4.1, §4.2 and §4.4 need Steptix to keep a file a
page downloads and give the step its path. Today nothing in `src/` handles a
download, and Playwright deletes a downloaded file when the browser closes
unless code saves it. That is its own change, and comes first.

## 12. Tests

- **Unit**, with scripted model replies (constructed, so they show how
  Steptix reacts, not what a model sends): each ending in §5.3; the allow
  list and the Allow/Deny timeout; refusing global installs; the scrubbed
  environment and the secret-by-name variables; killing a process tree
  (a command that starts a child that outlives its shell); file access
  outside the workspace refused; skill discovery and loading; the grammar
  and its runner-core parity. On Windows, Linux and macOS.
- **Unit, scope:** each row of the §5.6 table; a bare `[use agent]` that is
  not a block's first step refused; `[no-agent]` in and out of a scope, in
  both orders with `[no-hooks]`; the lexical rule both ways (ordinary section
  called from an agent scope, agent section called from an ordinary flow); a
  `[skill: …]` file not inheriting; claimed lines never becoming agent steps;
  the editor's marks and the report's labels agreeing for the same file.
- **Unit, the journeys the review found** (§15 has the review):
  - *Scope on every path (§5.7):* each entry point in the list sends the same
    `StepRequest.agent` for the same line, including Run From Here below the
    bare line, a section line run on its own, and Continue after a pause;
    `agentScopeOf` and its `src/` copy agree on a shared set of files.
  - *The question (§6.3):* no `canApprove`, no question; computer mode, no
    question; each row of the closing table, with the QuickPick hidden and a
    late answer ignored; the step line's *Waiting for your approval* set and
    cleared; a second window never shown the question.
  - *Once per pattern (§6.3):* an agent step in a 20-row `For each`, answered
    "Allow for the rest of this run" at row 1, asks nothing at rows 2 to 20;
    a new run asks again; an unanswered question at row 1 means no question
    at row 2.
  - *Context (§5.5):* parts 1 to 6 of a request are byte-identical from one
    turn to the next unless a skill was loaded or the log was folded; an
    older turn's full result and an older snapshot are absent; `notes`
    replace and persist; output over `resultMaxChars` is cut to head and
    tail; each shrinking step in order, and the failure when the fixed parts
    alone are too big; a secret printed by a command is masked in the next
    request; a new agent step starts with no log, notes or results.
  - *Naming the setting (§5.8):* each row of the refusal table appears in the
    failure with its setting; the shell-off line when nothing was refused; a
    passing step's refusals as report warnings.
- **Unit, report (§8):** a rendered agent step has the header, *Stored*, one
  *What it did* line per turn, *Files* and *Commands* matching what the
  scripted turns did; each action kind renders its block; the badge's reason
  for each of the three scopes; the sidecar folder holds every written file
  and one log per command, skips `node_modules` and `.venv` and files over
  `reportFileMaxBytes`, and survives the workspace's removal; a known secret
  in command output or a written file is masked in the HTML and the copies;
  output over 20 KB is cut to head and tail with the link; *Approvals this
  run* lists each run-long answer and an unanswered question; the run panel's
  lines and the finished report's lines agree for the same run.
- **Unit, whole-file report (§8.7):** an `agent: on` file shows the banner
  with the right count, the four extra summary stats, the agent steps table
  ordered by cost and linked to each step, the run's files with the step that
  wrote each, and the *opted out* marker on a `[no-agent]` step; a run with
  one `[use agent]` step and no `agent: on` shows the same header without the
  banner; a run with no agent step shows a report identical to today's; a
  data-driven run counts across rows and lists approvals once.
- **Live**, on `fixtures/test-app`:
  - an agent step that writes and runs a Node script, no installs;
  - the §4.1 shape against a fixture page that offers a CSV download, gated
    behind an environment variable because it reaches the npm or PyPI
    registry;
  - an agent step that loads a skill from a fixture skills folder.

  Turn counts and how often a model finishes within `maxTurns` are measured
  on these runs, not assumed.

## 13. Deferred

- MCP servers.
- Saving a script the agent wrote as a project tool, so later runs replay it
  without the model.
- Letting the agent call Steptix skills (`[skill: …]` macros).
- Limiting which tools and skills one test may use.
- Native tool calling where a provider has it.

## 14. Open questions

1. Should the workspace be per run (as above) or per step? See also §15.3.
2. Should `agent.folders` accept the system temp folder by a fixed name, so a
   test can say "my temp folder" portably?
3. A run-wide turn limit. An `agent: on` file can spend `maxTurns` on every
   step, which over the Copilot bridge is a lot of premium requests. Add
   `agent.maxRunTurns`, and if so, what default?
4. Can a section opt out of its file's `agent: on`? Today only single steps
   can, with `[no-agent]`.
5. Should an agent step inside a scope see the previous agent step's turns,
   so a section reads as one task? This draft says no (§5.5).
6. Should a QuickPick answer be able to add a pattern to
   `agent.allowCommands` for good? This draft never writes config (§6.3).

## 15. Review findings not addressed in this version

From the `/user-journey-review` of this spec on 2026-11-24: a design review,
traced against the spec and the code, with nothing run. The findings this
version answers are in §5.7 (scope on every path), §6.3 (the question, and
asking once per pattern) and §5.8 (naming the setting). These are left:

### 15.1 In computer mode the agent could click its own Allow (high)

An agent step in computer mode runs an unlisted command; the question
appears on the screen the agent is driving, and the agent could click Allow
like any other control. Constructed: no run has shown a model do this, but
the hole is there whatever the model sends. §6.3 asks no question in
computer mode, which closes it for this version. It stays listed so that
rule is not dropped later without a reason.

### 15.2 A secret a script prints reaches the model and the report (high, answered)

§4.5's script prints the response, or the token, while debugging itself.
The output went back to the model and into the report unmasked, which broke
§6.4's promise that the model never sees the token. Now answered: §5.5
renders every part of a request through the run's masking, command output
and file contents included, and §8.5 masks the report and its copies. It
stays listed because the fix lives in two places, and both have tests.

### 15.3 Stored paths point into a deleted workspace (medium)

An agent step stores `export_file`; the run ends and its workspace is
removed (§6.2); the author uses Run From Here on a later step in the same
session, which keeps its variables. `{{export_file}}` names a file that is
gone, and the tool fails with "file not found", saying nothing about the
cleanup. Suggested fix: keep the workspace for the life of the session, or
clear variables that point into it, with a note.

### 15.4 Installs fail on corporate networks with no clue why (medium)

§6.4's scrubbed environment drops proxy, registry and certificate variables
(`HTTPS_PROXY`, `NO_PROXY`, `npm_config_registry`, `PIP_INDEX_URL`,
`NODE_EXTRA_CA_CERTS`), so `npm install` or `pip install` fails with a
network error. Suggested fix: an `agent.env` list of variable names to pass
through, with the usual proxy names in its default, and the report naming
what was withheld.

### 15.5 Waiting for a download can look like a stall (low)

The agent lists the download folder repeatedly while a large file finishes;
three identical results trip the stall rule in §5.3 and the step fails as
stuck. Constructed. Suggested fix: a wait-for-file action with a timeout, or
not counting a wait as a repeat.

### 15.6 `.agents/skills` is shared with other agent tools (low)

Skills written for other agents in the same repository appear to Steptix's
agent too, including any that tell an agent to commit or push. Suggested
fix: default `agent.skillsDir` to a Steptix folder (`.steptix/agent-skills`),
or document the sharing.
