# Saving captured values to a file: the built-in `save_json` tool

Status: SHELVED 2026-09-29. The product owner chose to ship `save_json` as a
fixture tool instead (`fixtures/tools/src/save_json.ts`, flat records and
`key`, no template option), which projects copy like the other example tools.
The built-in design below is kept for if that changes. Its Context section
also records a separate gap that stands either way: Steptix sends no
`toolsDir` when a config omits `tests.toolsDir`, so the server sends every
`[tool:]` line to the model as prose.

## In plain terms

A test that reads values off a page keeps them in variables, and the
variables are gone when the run ends. Today the only way to keep them is to
write a TypeScript tool, and a tool needs a small Node project around it —
a `package.json`, a `tsconfig.json`, an `npm install` — which `steptix init`
does not create. For the most common case, *read ten fields off a form, once
per data row, and keep them*, that is too much to ask of every project, and
thousands of projects would each write the same forty lines.

This story ships one tool with the framework:

```markdown
11. [tool: save_json file="output/customers.jsonl" key="customer_id" customer_id firstname lastname email]
```

It works in every project, wherever it lives, with no file to copy and no
tools folder. Each call writes one record. The arguments are its fields, and
a bare name is already shorthand for `name="{{name}}"`, so the variable names
become the keys. The rules:

- **The extension picks the format.** A `.jsonl` file gets one line per
  record; a `.json` file holds one array of records.
- **`key` makes re-runs safe.** With `key="customer_id"`, a record whose
  `customer_id` is already in the file replaces that record where it sits.
  Without `key`, every call adds one. Nothing clears the file when a run
  starts; delete it to start over.
- **Nothing half-captured is written.** A field whose variable was never
  captured fails the step, instead of writing the literal text `{{phone}}`.
- **Secrets stay out unless the step asks for them.** A secret field fails
  the step unless the call says `include_secrets=true`.
- **It writes only inside the project**, only `.json` or `.jsonl`, and only
  into a file that is already a list of records or does not exist yet.

A project that already has its own `save_json` keeps it: a project's tools
are looked up before the built-in one.

It works whether or not the project has a tools directory:

| How the test runs | Tools directory | What reaches `save_json` |
| --- | --- | --- |
| Any runner | Declared and present | The project's tools, then the built-ins behind them |
| Any runner | Declared, missing on disk | The built-ins (today: an empty catalogue) |
| `steptix run` | Not declared | Defaults to `./tools/src`, so one of the rows above |
| Steptix (VS Code) | Not declared | A built-ins-only catalogue on the server (decision 10) |
| MCP, project resolved | Not declared | MCP sends the default, so one of the first two rows |
| MCP project-less, or a Sessions API call with no test file | — | Refused with the reason: there is no project to write into |

The last row is "no project", not "no tools directory", and it is the only
place the tool does not run.

### What it looks like in practice

**You write** a data-driven test:

```markdown
## Steps
| customer_id |
|-------------|
| C-1001      |
| C-1002      |
| C-1003      |

1. Navigate to /customers/{{customer_id}}
2. Read the value in the First name field [store as: firstname]
3. Read the value in the Last name field [store as: lastname]
4. Read the value in the Email field [store as: email]
5. [tool: save_json file="output/customers.jsonl" key="customer_id" customer_id firstname lastname email]
```

**You get** `<project>/output/customers.jsonl`:

```
{"customer_id":"C-1001","firstname":"Jane","lastname":"Byrne","email":"jane@example.test"}
{"customer_id":"C-1002","firstname":"Ravi","lastname":"Patil","email":"ravi@example.test"}
{"customer_id":"C-1003","firstname":"Ana","lastname":"Costa","email":"ana@example.test"}
```

**You run it again:** still three lines. Each row replaced its own.

**You fix row 2 and run** `steptix run tests/customers.md --row 2` (or Steptix's
*Run this row*): row 2's line is rewritten in place; rows 1 and 3 are
untouched.

**You change the path to** `output/customers.json`: the file is one array,
`[{"customer_id":"C-1001",…},{…},{…}]`, pretty-printed, rewritten on each
call.

**You loop inside one run:**

```markdown
6. Read the Order ID column as id and the Status column as status from every row in the Orders table [store as: orders]
7. For each {{order}} in {{orders}}, [tool: save_json file="output/orders.jsonl" key="id" id="{{order.id}}" status="{{order.status}}"]
```

One line per order. The handbook's "no collecting captures across the passes
of a loop" (§3.9) is still true of variables; a file is now the way to
collect.

**You pass a whole list:** `[tool: save_json file="output/run.json" orders]`
writes `"orders": [{"id":"A-1","status":"Paid"}, …]` — the captured list as a
real JSON array, not a string holding JSON.

**You forget a capture:** `… email phone]` with no step that stored
`{{phone}}` fails the step with *save_json: phone was never captured (the
step would have written the text "{{phone}}")*. Nothing is written.

**You include a password:** `… email password]` fails the step with
*save_json: password is a secret field; leave it out, or add
include_secrets=true to write it in plain text*. With the flag, the file holds
the real value; the report still shows `***`.

**You aim outside the project:** `file="../shared/out.jsonl"` or
`file="C:/exports/out.jsonl"` fails the step and names the project root it
must stay under. `file="package.json"` fails too: the file exists and is not
a list of records, so writing it would destroy it.

## Context: what exists

**Tools are looked up in the project and nowhere else.** Every `[tool: x]`
resolves against the project's `tests.toolsDir`
([registry.ts](../src/tools/registry.ts) `loadToolCatalogue`). There are no
built-in tools. The catalogue does have a second tier: `resolve` looks for an
indexed file first and falls back to a directly-`register`ed tool of the same
name only when no file matches ([registry.ts:266](../src/tools/registry.ts)).
That fallback is exactly the precedence this story wants, already written.

**A tool is told nothing about where it is.** `ToolContext` carries `page`,
`context`, `browser`, `step` and `log`
([types.ts](../src/tools/types.ts)); no project root, no test file. The
prototype had to guess the root as `path.resolve(import.meta.dirname,
'../..')`, which is right for the documented `tools/src/` layout and wrong in
this repo's fixture workspace, where it wrote to `fixtures/output/` instead
of `templates/init/`.

**Without `toolsDir`, the server sends `[tool:]` lines to the model as
prose** ([session-manager.ts:4222](../src/server/session-manager.ts)). And
Steptix sends no `toolsDir` when a project's config does not declare
`tests.toolsDir` (`steptix-config-parse.js` returns `null` for an undeclared
key), although the CLI defaults the same setting to `./tools/src`
([defaults.ts](../src/config/defaults.ts)). So under Steptix, in a project
whose config omits the key, a built-in tool would never be reached — it would
be read to the page model as a sentence.

**MCP refuses code steps with no project.** `run_steps` in project-less mode
refuses every `[tool:]` and `[skill:]` line up front
([errors.ts:108](../src/mcp/errors.ts), stories/mcp-no-project.md). That
stays: `save_json` needs a project root to write under.

**Tool steps are never compiled.** `[tool:]` lines are dispatched before the
AI loop ([generate.ts:75](../src/codebehind/generate.ts)), so a compiled test
calls the tool exactly as an uncompiled one does. Nothing to do in code-behind.

**The report masks tool arguments by value.** `redactReport` masks every
string in the report against the run's mask set
([secrets.ts](../src/utils/secrets.ts)), which covers a tool step's argument
rows. A secret written to the file is still `***` in the report.

**The prototype, measured.** The same tool as a project file
(`fixtures/tools/src/save_json.ts`, `tool()` helper) run by `steptix run` over a
three-row table with no page steps (0 tokens):

- three rows wrote three lines; `O'Brien` round-tripped;
- a second full run left three lines;
- editing row 1 and running `--row 1` rewrote that line in place;
- adding an uncaptured `phone` failed the step with `Not captured: phone`.

## Decisions

Marked **(confirm)** where the choice is the product owner's rather than a
consequence of the code.

1. **Built in, called `save_json`, reached with `[tool: save_json …]`.** No new
   step grammar: the tool syntax, its argument grammar, bare-name shorthand,
   placeholders, and the rule that a tool step takes no `otherwise` tail all
   apply unchanged. A project file
   that defines `save_json` wins, through the existing file-first lookup, so
   no project that already has one changes behaviour. The not-found message
   lists the built-in tools beside the scanned directory.

2. **The format follows the extension.** `.jsonl`: one compact object per
   line, appended or replaced in place. `.json`: one pretty-printed array,
   read and rewritten on each call. Rows never run in parallel
   (stories/data-driven-rows.md decision 6), so read-modify-write is safe
   within a run. Any other extension fails the step.

3. **Paths are relative to the project root and may not leave it.** The
   project root is the folder holding `steptix.config.json` — the one every
   runner already resolves from the test file. An absolute path is accepted
   only when it is inside that root. **(confirm)** — this rules out writing
   straight to a shared folder outside the project; see §Open questions.

4. **An existing file is written only if it is already a list of records.**
   For `.jsonl`, every non-blank line must parse as a JSON object; for `.json`,
   the file must parse as an array of objects. Anything else fails the step
   and the file is untouched. This is what keeps a correct path from
   corrupting someone's data, and it is also the guard that stops
   `file="package.json"`, `tsconfig.json` or `.vscode/settings.json` being
   overwritten — they are objects, not lists — without a list of forbidden
   names that would never be complete.

5. **`key` replaces in place; nothing resets the file.** With `key="f"`, the
   first record whose `f` equals the new record's `f` is replaced at its
   position (the prototype's first cut removed and appended, which reordered
   the file on every one-row re-run). No `key`: append. `key` must name one
   of the fields. There is no "fresh at the start of a run" rule: Steptix
   runs rows as separate sessions and *Run this row* would wipe the other
   rows' records. **(confirm)**

6. **Uncaptured fields fail the step.** A field whose value is still the
   literal `{{name}}` (what `interpolate` leaves for an unbound placeholder)
   fails the step and writes nothing. An empty string is a value and is
   written. To keep going past a missing optional value, capture it with an
   `otherwise continue` tail and a `Set {{phone}} to ""` beforehand.

7. **Lists and records are written as JSON.** A field whose value parses as a
   JSON array or object — what list reads, table reads and a `For each` item
   hold — is written as that structure. Everything else is a string, numbers
   included, so `"007"` stays `"007"`. Documented, because a value typed as
   `[1]` becomes an array too.

8. **Secret fields fail unless `include_secrets=true`.** A field is secret
   when its name is (`isSecretParameterName`, the report's rule) or its value
   is in the run's mask set (a password stored under a harmless name).
   Refusing, not masking: `***` in a data file is the silent wrong value this
   codebase ranks worst (issue 060's reasoning). With the flag, the real
   value is written and the report still masks it. **(confirm)**

9. **Every tool learns the project root.** `ToolContext` and `ToolScope` gain
   `projectRoot: string | undefined`, documented in handbook §7.2. The
   built-in needs it; so did the prototype, and so does any user tool that
   writes or reads a project file. The run's mask set reaches built-ins only,
   through an internal option, and is not part of the published tool API.

10. **The server dispatches built-ins without `toolsDir`.** A batch with no
    `toolsDir` and no cached catalogue gets a built-ins-only catalogue. So
    `[tool: save_json]` runs under Steptix in a project whose config omits
    `tests.toolsDir`, and any other `[tool: x]` there now fails "not found"
    instead of reaching the page model as prose. That second half is a
    behaviour change, and a fix: the old path was a silent wrong answer.
    **Confirmed 2026-09-29**: it must work for projects with and without a
    tools directory.

11. **With no project root, the step fails.** A Sessions API caller that
    sends no test file path (so no project resolves) gets *save_json needs a
    project: no steptix.config.json was found for this run*. MCP project-less
    runs never get this far (Context, above).

12. **Steptix knows it is built in.** F12 on `[tool: save_json]` says it is
    built into the framework, with a link to handbook §7.5, rather than
    warning that the tools directory has no such file — unless the project
    has its own `save_json`, which F12 opens as today. Tool-name completion offers `save_json`. This is the only
    runner-core / steptix-vscode change, so the Steptix patch version is
    bumped with it.

## Design

### `src/tools/builtin/save-json.ts` (new)

A plain `ToolDefinition` rather than a `defineTool` call, because the
argument set is open: `acceptsExtraArgs: true` and `parameters: {}`, the
shape `tool()` produces. `run` does, in order: split `file`, `key` and
`include_secrets` off the fields; refuse uncaptured fields (6); refuse secret
fields (8); resolve and confine the path (3, 11); check the extension (2);
read and validate an existing file (4); decode list/record values (7); write
(5) with `mkdir -p`. One log line names the file, the record count and
whether the record was added or replaced.

Writes go through a temp file and a rename, so a crash mid-write leaves the
old file whole rather than half a `.json` array.

### `src/tools/builtin/index.ts` (new)

`registerBuiltInTools(catalogue)`. `loadToolCatalogue` calls it on every
catalogue it builds, CLI and server alike — including the early return for a
missing directory, whose WARN changes from *no tools registered* to *no
project tools; built-in tools are still available*. The not-found message
lists the registered names.

### Executor and context

`ExecuteToolStepOptions` gains `projectRoot?: string` and `secrets?: readonly
string[]`. `ToolContext` / `ToolScope` gain `projectRoot`. The CLI passes
`resolveProjectRoot(test.filePath)`; the server passes
`projectBundle.projectRoot`. Both already hold the mask set for the report.

### Server

The `toolsDir` block in `postSteps` (session-manager.ts ~4219): when there is
no `toolsDir` and no cached catalogue, build a built-ins-only catalogue and
cache it like any other, so a later batch that does send `toolsDir` replaces
it through the existing `needsFullLoad` path (its `indexedCount === 0`).

### runner-core and Steptix

`invocation-target-core.ts` learns the built-in names (a constant mirrored
from `src/tools/builtin/index.ts`, with a parity test in the audit suite, as
the other mirrors have). `definition-provider.ts` and tool completion consult
it when no project file matches.

### Docs

Handbook §7 gains §7.5 *Built-in tools* with the examples above; §7.2 gains
`projectRoot`; §3.9's loop bullet points at `save_json`; the pitfalls table
gains `key=customer_id` (unquoted, a parse error) → `key="customer_id"`. The
AI authoring guide gets one line and one example.

## Tests

Unit (`save-json.test.ts`, temp project dirs): each format appends; `key`
replaces in place and keeps order; missing `key` field refused; uncaptured
field refused and nothing written; empty string written; list and record
values decoded, `"007"` kept a string; secret by name and by value refused,
written with `include_secrets=true`; `..`, an outside absolute path, a bad
extension, an existing non-list file each refused with the file untouched;
no project root refused; temp-and-rename leaves the old file on a simulated
write failure.

Registry: built-in resolves with no tools dir; a project `save_json.ts`
shadows it; not-found lists built-ins.

Server: a batch with no `toolsDir` dispatches `save_json`; an unknown
`[tool: x]` with no `toolsDir` fails "not found" and never reaches the model
(assert zero AI calls).

CLI end to end, no model: a three-row table plus `save_json`, run twice and
once with `--row 2`, asserting the file each time — the prototype run,
kept as a test.

runner-core audit: the built-in-name mirror matches. steptix-vscode fast
suite: F12 and completion on `save_json`.

Live: one Steptix run of a data-driven fixture test in `templates/init`
against the fixture app, asserting the written file. The server contract
changes (decision 10), so this one earns a live test.

## Not in this story

- Other formats (CSV, a record per file). `.jsonl` opens in every data tool.
- A row number field (`_row`) added automatically. `key` covers re-runs;
  revisit if people ask which row wrote a line.
- Writing outside the project (decision 3).
- Reading the file back into variables. A later test can already read a
  `.json` array through frontmatter `dataSources`.
- More built-in tools. The mechanism allows them; each is its own story.

## Open questions

- **Outside the project.** Is "only inside the project" right for everyone,
  or does a team need to export to a shared folder? If so, the likely shape is
  an allow-list in `steptix.config.json` (`tools.saveJson.allowedDirs`), never a
  per-step override — a step that can widen its own permissions is not a
  limit.
- **The name.** `save_json` reads well beside `.jsonl` too. `save_record`
  would say what one call does; `save_json` says what a person searches for.
