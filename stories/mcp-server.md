# MCP server — agents send steps and test files over stdio

> **Verification rule for this story.** "Done" means: (1) with `.mcp.json`
> checked into this repo, Claude Code lists the tools and `run_steps`
> executes steps in a live browser session, returning per-step results;
> (2) `run_test_file` runs an existing sample test end-to-end —
> frontmatter env/dataSources resolved, inline sections executed, report
> written — and its result carries per-step status, per-step error text,
> the report path and token totals; (3) with no server running, the first
> tool call auto-starts `steptix serve` on the port `SERVER_URL` names, with
> the project's API key, and the run proceeds — no terminal involved,
> **and `steptix status --url $SERVER_URL` can still see the server it
> started**; (4) two
> successive `run_steps` calls with the same `session_id` share page
> state and captured variables; (5) cancelling a call mid-run aborts the
> run server-side and leaves the session open, and — when the host
> supplies a `progressToken` — progress notifications are observed
> (asserted in the seam test; a host that never sends one is recorded,
> not a failure); (6) the same stdio server works from Codex CLI and
> Copilot CLI. A vitest seam test driving the MCP server through a real
> in-memory MCP client, and one driving a real `createApiServer` app over
> HTTP, are part of the contract.

## Context

Agents (Claude Code, OpenAI Codex, GitHub Copilot) should be able to
drive this framework: send a handful of steps to a live browser session,
or run a whole `.md` test file, and read structured results back. Today
the only programmatic clients are the Steptix extensions and the CLI.

The execution machinery already exists behind the Sessions API
([src/server/api-server.ts](../src/server/api-server.ts)):
`POST /sessions/:id/steps` accepts steps + config + env + sections and
streams per-step SSE events; sessions auto-create on first request and
stay open for reuse; `/health`, auto-start and the idle timeout are done
(story [server-lifecycle.md](server-lifecycle.md)). The MCP server is a
translation layer over that seam — the position Steptix occupies (the
"Steptix extensions are HTTP clients" rule).

Target hosts, all stdio, all on the same machine as the browser:

| Host | Config | Scope |
| --- | --- | --- |
| Claude Code | `.mcp.json` | per-project, in repo |
| Copilot in VS Code (agent mode) | `.vscode/mcp.json` | per-project, in repo |
| Codex CLI + Codex VS Code ext | `~/.codex/config.toml` | machine-global |
| Copilot CLI | `~/.copilot/mcp-config.json` | machine-global |

(Note: [SPEC.md](../docs/specs/SPEC.md) §"Direct Playwright over Chrome MCP" is the
reverse direction — *consuming* an MCP browser backend — and is
unrelated.)

## Locked decisions

- **stdio transport only.** Streamable HTTP (ChatGPT-cloud connectors,
  remote clients) is out of scope — it drags in tunnelling and OAuth.
  Handlers are transport-agnostic so HTTP could be added later.
- **HTTP client of the Sessions API** — never runs tests in-process. One
  server owns browsers, sessions, cache and lifecycle; agent and
  Steptix sessions coexist.
- **Sync calls with progress notifications.** One call = one run. No
  async job model in v1 (the named escape hatch if hosts time out).
- **`run_test_file` takes a single path.** No glob/batch in v1.
- **Debug protocol out of scope**: no breakpoints, step-mode,
  run-control, tool-debugger. `frame:push` is **consumed privately by
  the fold** (§2) but never exposed; `frame:pop`, `frame:scope`,
  `step:awaiting`, `tool:awaiting-debugger` are ignored.
- **No `runner-core` dependency.** *(Reversal of an earlier draft.)* The
  main package already owns every piece: `parseTestContent` +
  `scanStepSpans` ([src/parser/markdown.ts](../src/parser/markdown.ts))
  give unexpanded steps, `stepLines`, and a `matchText`-keyed `sections`
  map whose `ParsedSection` carries the four fields
  `validateSectionEntry` demands — and it throws on duplicate/reserved/
  empty section names, the pre-flight Steptix implements separately.
  `matchText` is at [src/parser/section-match.ts](../src/parser/section-match.ts)
  (the copy `api-server.ts` uses); `discoverTestFiles` and the env
  readers are in-package. The dep would have cost a CJS package inside
  an ESM one, a second `matchText` in one process, an `ApiClient` with
  no `/sessions` or `/health` method, and a TB catalogue naming VS Code
  settings that do not exist here. **No TB codes**; the MCP emits its
  own messages (§7).
- **`steptix mcp` never builds the commander program.** Registering it
  inside `createCli()` makes `cli/index.ts → serve.ts → api-server.ts →
  session-manager.ts → browser/manager.ts` a static value-import chain,
  so every MCP startup would eagerly load playwright — measured
  1082–1499 ms for the CLI graph, against ~250 ms for the MCP SDK and
  ~91 ms for the parser. Only `src/browser/manager.ts` value-imports
  playwright (the other 13 are `import type` and erase), so the bypass
  genuinely keeps it out. §1.
- **Roots confinement** (§4a) for every agent-supplied or
  config-derived path. Without it an agent, or web content that
  prompt-injects one, points the framework at any directory on disk to
  run its tool code and read its secrets.
- **A project root is required.** No `steptix.config.json` within the
  allowed root ⇒ invalid-params naming `STEPTIX_MCP_ROOTS` first, then the
  directories searched.
- **`isError` is reserved for pre-flight.** A run that reached the
  server returns a normal result whose `status` says what happened.
  Rationale: `isError` results carry no `structuredContent`, so the
  agent would lose `sessionId`, `steps` and `reportPath` exactly when it
  needs them. **Self-enforced** (§2) — the SDK will otherwise produce
  that shape silently.
- **Session IDs**: agent-supplied, else `mcp:<absolute test path>` for
  `run_test_file` and `mcp:steps-<pid>-<short-hash(projectRoot)>` for
  `run_steps` — project-scoped, because one process may serve two roots
  and an unscoped id would reuse one browser across projects while the
  second project's `config` silently never applied. An id not starting
  `mcp:` is refused unless `allow_foreign_session: true`.
- **Auto-start spawns this package** with a normalized `--host`/`--port`
  derived from `SERVER_URL`, `--inspect=0` and an explicit `env` (§5).
- **One MCP process per host session**; cross-process collisions on a
  shared session id are accepted and documented (§6).

## Design

### 1. `steptix mcp` (entry, and why it bypasses the CLI)

[src/index.ts](../src/index.ts) today is exactly five lines: shebang, a
**static** `import { createCli } from './cli/index.js'`,
`const program = createCli()`, `program.parse(process.argv)`. There is
**no** error handling, exit-code logic, unhandled-rejection handler or
argv massaging to preserve — do not go looking for one. ESM hoists that
import, so the whole CLI graph (including `loadDefaultEnvFileSync()` at
module scope, and transitively playwright) evaluates before any
statement in the body; an `if (argv[2] === 'mcp')` guard above it is a
no-op. The entry becomes:

```ts
#!/usr/bin/env node
if (process.argv[2] === 'mcp') {
  const { setLogStream } = await import('./utils/logger.js');
  setLogStream('stderr');
  const rest = process.argv[3];
  if (rest === 'help' || (rest !== undefined && rest.startsWith('-'))) {
    const { MCP_USAGE } = await import('./mcp/usage.js');
    process.stderr.write(MCP_USAGE);
    process.exitCode = 0;
  } else {
    await (await import('./mcp/server.js')).main();
  }
} else {
  const { createCli } = await import('./cli/index.js');
  createCli().parse(process.argv);
}
```

Notes, each closing something an implementer would otherwise get wrong:

- The shebang is **retained** (`bin.steptix → dist/index.js`). Verified:
  `tsc` preserves it and vitest imports a shebang'd `.ts` entry with
  top-level `await` without complaint (`module: NodeNext`,
  `target: ES2022`).
- The only behavioural delta in the else branch is that
  `loadDefaultEnvFileSync()` now runs one microtask later. `.parse()`,
  not `.parseAsync()` — async handlers stay detached and exit codes keep
  coming from commander and from handlers that call `process.exit`
  themselves.
- **The help guard is wider than `--help`**: `steptix mcp help`,
  `--version`, `-V` would all otherwise fall through and start a stdio
  server that hangs a human's terminal.
- `process.exitCode`, **not** `process.exit(0)` — stderr to a pipe is
  asynchronous on win32 and this is a Windows-primary project, so an
  immediate exit can truncate the usage text.
- `MCP_USAGE` lives in **`src/mcp/usage.ts`**, imported dynamically
  *inside* the guard. A static import of anything under `src/mcp/` from
  the entry would defeat the bypass on every CLI invocation; a literal
  in the entry would drift from the W6 README.
- A **description-only `.command('mcp')` stub** is still registered
  inside `createCli()` so `steptix --help` lists it. Verified against
  commander 14.0.3: `steptix mcp` with no action handler returns normally
  and exits 0; `steptix bogus` still errors; `steptix help mcp` prints the
  stub. It is never reached, since argv is intercepted first. One
  residual, theoretical today (there are no global pre-subcommand
  options): an invocation where `mcp` is not argv[2] reaches the stub
  and silently exits 0. Because the stub answers `steptix help mcp` on
  **stdout** while the guard answers `steptix mcp --help` on stderr, point
  the stub's `.description()` at `steptix mcp --help` as the canonical
  text.

**stdout is the protocol channel** — any non-JSON-RPC byte corrupts the
session. `logger` has **14 stdout-bound `console.log` call sites across
8 methods**: `debug`, `info`, `success`, `subAction` (guarded by
`shouldEmit`) and `step`, `assertion`, `testStart`, `testEnd`
(**unguarded**, so `setLogLevel('silent')` does not silence them —
`assertion`/`testStart`/`testEnd` are three calls each). `warn`, `error`
and `tokenWarning` already use `console.warn`/`console.error` and need
no change.

Implement `setLogStream` with a **module-level private `Console`**, not
14 hand-rolled `stream.write` calls — the latter would lose `%s`/`%d`
formatting and `util.inspect` of the rest args:

```ts
import { Console } from 'node:console';
let out: Console = globalThis.console;
export function setLogStream(t: 'stdout' | 'stderr'): void {
  out = t === 'stderr' ? new Console({ stdout: process.stderr, stderr: process.stderr }) : globalThis.console;
}
```

then `console.log(` → `out.log(` at the 14 sites. `main()` additionally
redirects the **global** console before connecting the transport:
`setLogStream` covers only our logger, and a transitive dep that prints
at load would still corrupt the channel. *(chalk needs no handling: it
derives its level from `supportsColor.stdout` at import, so on the MCP
path stdout is a pipe, `chalk.level === 0`, and no ANSI reaches stderr.
Do **not** force `chalk.level` — that would push ANSI into a redirected
log. Recorded so it is not re-litigated.)*

Nothing else on the mcp path prints to stdout — verified across `src/`.
`src/parser/parameters.ts` imports `node:readline/promises` and
`{stdin, stdout}` at module scope but only builds the interface inside
its prompt path, so importing it is safe (see §3 for why it must never
be *called*).

### 2. Tool surface

Fifteen tools, **bare names** — the host prefixes them, so a `steptix_`
prefix would render as `mcp__steptix__steptix_run_steps`. The seven enumerated
below are this story's; the eight added since are specced elsewhere —
`start_cdp_browser` and `list_cdp_browsers` in
[mcp-cdp-browser.md](mcp-cdp-browser.md), `close_cdp_tab` in
[cdp-tabs.md](cdp-tabs.md), `focus_cdp_tab` in
[cdp-tab-focus.md](cdp-tab-focus.md), `get_page_content` in
[page-content.md](page-content.md), `get_run_settings` in
[run-settings.md](run-settings.md), `run_errand` in
[errands.md](errands.md), `peek_tab` in
[tab-peek.md](tab-peek.md). Each declares a zod
`outputSchema`; SDK 1.29.0's `registerTool` accepts **either** a raw
shape or a `z.object({…})` (`ZodRawShapeCompat | AnySchema`), so either
form is fine. Every tool accepts optional `project_root`, including the
four session tools, whose URL and key are per-project and which are
otherwise unusable on the machine-global hosts. Descriptions embed a
condensed step-syntax reference. MCP `resources`/`prompts` are unused in
v1 — every target host gives the agent filesystem access.

- **`run_steps`** — `{ steps, session_id?, project_root?, env_name?,
  parameters?, config?, allow_foreign_session?, include_screenshot? }`.
  Assembles the **same project fields as `run_test_file`** (§3) so
  `[skill: x]`/`[tool: x]` lines execute instead of shipping to the AI
  as prose. Sends a synthetic `testFilePath` of
  `<project_root>/.steptix-mcp-steps.md` — load-bearing, because the server
  derives project root, env/data bundle, report dir and cache anchor
  entirely from it. *(Verified: no server path reads `testFilePath` from
  disk. Deliberate — Steptix buffers may be unsaved.)* Reports are
  named from that basename, so `reportPath` reads
  `<root>/reports/.steptix-mcp-steps-*.html` — harmless, agent-visible.
  Synthesizes `sourceLines: [1..n]`.
- **`run_test_file`** — `{ path, env_name?, parameters?, config?,
  session_id?, project_root?, allow_foreign_session?,
  include_screenshot? }`.
- **`list_test_files`** — `{ project_root? }`. Wraps
  `discoverTestFiles(dir, pattern)` — **both args required**; read
  `tests.dir`/`tests.pattern` from `steptix.config.json`, falling back to
  the `defaults.ts` literals (`'./tests'`, `'**/*.md'`; the key is
  `tests.dir`, not `tests.directory`). Returns **absolute, sorted**
  paths and does **not** filter `type: skill` files (that needs
  parsing) — say so, or an agent will `run_test_file` a skill and hit
  §7's refusal.
- **`list_sessions`** — `sessionId`, `status`, `currentUrl`,
  `pageTitle`, `totalStepsExecuted`, plus derived
  `owner: 'mcp' | 'other'`. `getActiveSessionsWithTitles` awaits
  `page.title()` per session untimed, so use a **5 s client-side
  timeout**; a timeout is `isError:true` naming the likely cause.
- **`close_session`** — `{ sessionId, closed: true }`; unknown id
  succeeds (idempotent route).
- **`get_last_run`** — **polls** until `finalized` or ~12 s with
  backoff, as Steptix does; a pass-through returns
  `{finalized:false}` right after a cancel, which is the tool's purpose.
  Schema: `{ finalized, reportPath: string|null, tokens: {total, input,
  output} | null }`.
- **`server_status`** — the `HealthResponse` fields verbatim plus the
  probed `baseUrl`. Calls `probeHealth` **directly, and never
  auto-starts**: routing it through `ensureServerReady` would make
  "is a server running?" *start* one, and would turn a down server into
  a §7 pre-flight error instead of the status the tool exists to
  report. All probe arms are reported as a normal result. No `stop`
  tool.

`structuredContent` must be a JSON **object**, so the two list tools
wrap their arrays: `{ files: [...] }` and `{ sessions: [...] }`.

**Every tool's `content[]` carries the summary *and* the data.**
`content[0]` is a short text summary; `content[1]` is
`JSON.stringify(structuredContent)`, compact; any tool-specific block (the
run tools' image) follows. This **reverses** an earlier rule here — *"do
not duplicate the full JSON as text"* — which assumed `content` was merely
the fallback channel for hosts that ignore structured output. Measured
2026-08-08 across two hosts against one server, that assumption is wrong in
both directions. Claude Code prefers `structuredContent` and, when it is
present, records **only** that, transcript included. opencode returns
`content` untouched whenever it is non-empty
(`packages/opencode/src/mcp/catalog.ts`), so a summary is all its model
ever sees: `list_cdp_browsers` arrived there as `1 running, 2 available
(not started)`, carrying none of the `targetId`s that `close_cdp_tab`'s
own description tells the agent to read out of it. The spec puts the duty
on the server — *"a tool that returns structured content SHOULD also
return the serialized JSON in a TextContent block"* — so this is us
catching up, not a workaround for one host.

Keep the summary: it carries counts, truncation and warning tallies that
raw JSON does not narrate. Keep the JSON block **unconditional** — a
per-tool opt-out cannot coexist with §Tests' all-tools guard, so any future
exception must be added to both in one change or it is not visible.
`isError` results are untouched: they carry no `structuredContent`, and
their `content` text is the one thing Claude Code *does* persist, which is
why refusals still reach the model there.

Two consequences, stated rather than left to be discovered.
`get_page_content` **drops** its own raw-page block instead of stacking on
top of the standard one (measured 1.05x the page for replacing, 2.05x for
stacking), so its content-block copy is now escaped text inside an object;
no human reader pays for that, since Claude Code records only
`structuredContent` and opencode's TUI hides tool output by default. And on
content-only hosts, `captures` and `steps[].output` — values scraped from
the page — now travel to a model provider that did not previously receive
them. That is deliberate, and it is a different call from the screenshot
one below: a screenshot would not exist at all unless opted in, whereas
captured text is produced on every run and is the data the tool exists to
return.

**Result shape** for the two run tools:

```json
{
  "status": "passed | failed | error | aborted",
  "streamDropped": false,
  "sessionId": "mcp:…", "projectRoot": "c:/proj",
  "sessionCreated": true, "configApplied": true, "queuedForMs": 0,
  "steps": [
    { "index": 0, "sentIndex": 0, "line": 12, "uri": "c:/proj/tests/x.md",
      "frameKind": "test | skill | section", "frameName": null,
      "text": "Click Login",
      "status": "passed | failed | skipped | not-run | unknown",
      "output": null, "error": null, "fromCache": false, "durationMs": 1840 }
  ],
  "captures": { "orderId": "12345" },
  "messages": [{ "level": "error | warn", "text": "…" }],
  "warnings": ["…"],
  "reportPath": null, "tokens": { "total": 0, "input": 0, "output": 0 },
  "error": null
}
```

`uri` is an **absolute OS path**, not a `file://` URL — every server
value is an OS path, and agents pass it straight back to
`run_test_file` and to file reads.

**Folding algorithm.** `steps[]` merges two row kinds:

- **Executed rows**, one per `step:start`, in arrival order. There is
  one per *executed* step, not per *sent* step, because server-side
  expansion replaces a `[skill: x]` line with its body — more events
  arrive than steps were sent, and a sent skill/section call produces
  zero root events of its own. A cursor over the sent array
  mis-attributes everything after the first expansion, and §3 makes
  expansion the normal case.
- **Synthetic rows** for sent steps that produced no event, inserted at
  their `sentIndex` position — after any executed row already holding
  that `sentIndex`, so a real execution always precedes its synthetic
  siblings. They carry `line = sourceLines[sentIndex]`,
  `uri = testFilePath`, `frameKind: 'test'`, `frameName: null`, `text`
  from the sent array, `durationMs: null`, `fromCache: false`, and
  `output`/`error` null. **None are emitted when `sourceLines` was
  omitted** — without it there is no `sentIndex` to place them at.

`index` is the final array position; `sentIndex` is the position in the
sent array, or `null`.

- **Root vs expanded**: root iff `frame === undefined` **or**
  (`frame.kind === 'test'` **and** `frame.id === ''`). *(`frameInfoFor`
  returns `undefined` when no expansion ran at all, and otherwise
  synthesizes a root frame as `{id:'', kind:'test', uri:testFilePath,
  line:0}`. Code to the rule, not to a "frame is always present"
  invariant — that is false.)* When `frame` is absent, default `uri` to
  `testFilePath` and `frameKind` to `'test'`. Root frames carry
  `line: 0`, so `uri:line` is not an identifier there.
- **Root rows** recover the sent step by `event.line → sourceLines`
  index. Exact whenever `sourceLines` was sent: `effectiveSourceLines`
  initialises to `request.sourceLines`, so a root `event.line` is the
  sent line whether or not expansion ran, and root lines are unique per
  sent step. When `sourceLines` was **omitted**, `sourceLineFor` falls
  back to the *expanded* index + 1 — so `sentIndex = event.line - 1`
  holds only if nothing expanded, and rows get `sentIndex: null` with
  `text` omitted whenever `skillsDir` or `sections` were sent.
- **Expanded rows** omit `text`; `uri` + `line` + **`frameName`** (from
  `frame.skillName`, which carries the section name for
  `kind:'section'`) identify them. Never key a map by line here — a
  section invoked twice yields duplicate `(uri, line)` pairs.
- **`sentIndex` for expanded rows** needs the outermost frame, whose
  `FrameInfo` only arrives on `frame:push`. The fold keeps a private
  `id → FrameInfo` map, walks `parentId` to the outermost frame, and
  uses its `line` — the invocation's `sourceLines` value, threaded
  identically for skill and section frames, and always pushed before the
  `step:start` that references it.
- **Unaccounted sent steps** (no executed row, no ancestry pointing at
  them) are **`unknown` by default**. They are `not-run` *only* when
  the run ended `failed`/`error`/`aborted`, `streamDropped` is false,
  and they follow the last terminal event. Everything else — an
  unaccounted step *before* the last terminal event on a failed run, a
  run where the last executed row has `sentIndex: null` so "follows" is
  undecidable, and every step of a dropped stream (where the run may
  still be executing, so claiming non-execution would be a lie in the
  same payload that says so) — stays `unknown`. **A passing run must
  never report a `not-run` step.** This is not pedantry: conditional/branched
  groups emit **no events at all** (the branched path pushes results and
  increments counters but never calls `emit`, consuming N+1 sent indices
  including the continuation step), and a branched group at the *end* of
  a passing run has no later terminal event — the naive "after the last
  terminal event ⇒ not-run" rule would report a passing branch as never
  executed. A `warnings[]` entry says per-step attribution is
  unavailable for part of this run; word it to cover both causes
  (conditional groups, and a skill whose `## Steps` is empty — only
  *sections* guard emptiness).
- **Started but never terminated** (abort, stream drop) are `unknown`.
- **`step:pass` with `output === 'skipped'`** is `skipped` — how the
  server reports an `[input:]`/`[interactive]` step it declined to run.
  Reporting it `passed` is a false green.
- **`durationMs`** is measured between `step:start` and the terminal
  event; **`null`** when there is none. Never measure to `done`.
- **Per-step `error`** from `step:fail.error`. Top-level `error`
  precedence: last `step:fail.error`, else last `output` with
  `kind:'error'`, else null.
- **`messages[]`** takes `output` events of kind `error`/`warn` only,
  filtered **client-side**, capped (last 50, 500 chars). Window is
  **stream-open → `done`**, *not* first-`step:start` → `done`: the
  failure classes that exist only as `output` events — bad `env_name`,
  tool-catalogue load failure, skill-expansion failure — all emit
  **before any `step:start`**, and a narrower window drops exactly the
  messages that matter. We deliberately send **no `logging` override**:
  the server implements it as a process-global `setLogLevel`, so
  quieting our run would silently downgrade a concurrent Steptix run's
  SSE output. For the same reason (logger callbacks are process-global)
  `messages[]` and the `output`-derived `error` fallback may contain
  another session's lines: **best-effort**, documented in the tool
  description.
- **`captures`** from `capture` events only (sources `capture`,
  `toolOutput`); last write wins on a duplicate name.
  Parameter-sourced outputs never appear as events and are excluded.
- **`reportPath`** read off the `done` event when present (already on
  the wire; the `RunEvent` type under-describes `done` because the
  emitter spreads it in), else the `get_last_run` poll. `tokens`
  requires the poll. **A failed poll** (timeout, 401, connect failure)
  ⇒ `reportPath: null`, zeroed `tokens`, a `warnings[]` entry, and it
  **never** changes `status` or `isError`.
- **Screenshots** are opt-in (`include_screenshot`, default **false**):
  the **last `step:fail.screenshot`** only (`step:pass` carries one too;
  ignore it), prefix-stripped from `data:image/png;base64,…`, dropped
  with a `warnings[]` note above ~1.5 MB of base64. Default-off because
  a screenshot of a failing page in this repo's own tests is a live
  banking or GitHub session, egressed to a model provider. Absent ⇒ no
  image, no warning.
- **`content[]`** is never empty: `content[0]` is a short **text
  summary** (status, N/M passed, first error, reportPath) — the SDK
  synthesizes no text from `structuredContent`, so without it a
  content-rendering host has nothing. `content[1]` is the serialized
  result, per the all-tools rule above. The image block, when opted in,
  is appended **last**.

**Output validation is self-enforced.** `validateToolOutput` throws when
`structuredContent` is missing or fails the schema, but the SDK's
handler **catches it and returns `{content, isError:true}`** — silently
producing exactly the shape the locked `isError` decision forbids. So:
`safeParse` before returning; on failure return a **valid** result
(`status:'error'`, diagnostic in `warnings[]`, whatever validated) and
cover it with a test. Zod strips unknown keys (extras are not an error,
and the SDK returns the original object so extras still reach the host),
but **missing required keys are fatal** — every nullable field needs an
explicit `.nullable()`/`.optional()`: `error`, `reportPath`,
`durationMs`, `frameName`, `output`, `text`, `sentIndex`. **This applies
to all 15 schemas, not just the run result** — `server_status`
carries `inspector: string|null` and `idleTimeoutMinutes: number|null`
straight from `HealthResponse`, and `get_last_run` has two nullables of
its own.

**Transport failures** (the fold assumes a well-formed stream):

| Wire outcome | Result |
| --- | --- |
| 400 (empty/non-string `steps`, malformed `sections`, `sections` without `testFilePath`, id > 1024) — fires **before** headers flush, so real HTTP JSON even with `?stream=1` | `isError:true`, quoting the server's `error` |
| 401 | `isError:true`, naming **both** key sources |
| 503 `Server is shutting down` (gate precedes auth — a concurrent `steptix stop`) | `isError:true`, says to retry |
| 500 | `isError:true`. The error middleware hardcodes 500 and ignores `err.status`, so body-parser's **413 arrives as a 500** `request entity too large`; `express.json()` is bare, so a ~100 kb ceiling covers `steps`+`sections`+`env`+`parameters` combined. Say so |
| reader ends **after** a `done` event | normal fold |
| reader ends **without** `done` | `status:'error'`, `streamDropped:true`, one `get_last_run` poll, text saying the run may still be executing server-side |
| `reader.read()` **throws** | check `signal.aborted` **first** — our own abort is cancellation (returns nothing to the host), not a dropped stream |

`done.status === 'aborted'` is effectively unreachable by the client
that caused it (the only abort source is `res.on('close')`, and every
`writeSseEvent` is gated on `clientGone`). Map an observed one to
`status:'aborted'` plus a `warnings[]` note, documented as not-expected.

### 3. Test file parsing + request assembly

**Call order is pinned** — the naive order reads files before refusing
them, and resolves the env before it knows which env to use. Steps
marked **(file)** apply to `run_test_file` only; `run_steps` skips them
and instead builds its synthetic `testFilePath` by joining the
already-confined `project_root` with `.steptix-mcp-steps.md`. **That path
is never realpath'd or existence-checked** — it does not exist on disk,
and running it through step 2 would ENOENT and return §7's missing-file
error for every `run_steps` call.

1. **(file)** Refuse a relative `path` (§7).
2. **(file)** `fs.realpathSync.native(path)` — also the missing-file
   detector, and it must run **before** any read. *(`realpath.native`
   does not exist on the promises API; use the sync form or promisify
   the callback one.)* Re-format its `ENOENT` into §7's wording.
3. **(file)** Assert inside the allowed roots (§4a).
4. Walk up for `steptix.config.json`, **bounded by the root** (§4a rule 4).
5. Read that JSON directly (not `loadConfig`).
6. Resolve and re-check `skillsDir`/`toolsDir`/`tests.dir` (§4a rule 5).
7. `readDefaultEnvVars(root)` — the base `.env` only.
8. **(file)** `readFile` the test.
9. **(file)** `parseTestContent(raw, absPath)`.
10. **Resolve `envName`** (tool arg, else frontmatter `env:`, else
    none), validate per §4a rule 6, and layer `readEnvFileVars` on top
    of step 7's map. *This step exists separately because the
    frontmatter name is not known until step 9 — resolving the env at
    step 7 would silently ignore `env: uat` in a test file, running it
    with the base `.env` only: wrong `SERVER_URL`, wrong AI key, wrong
    interpolation, and rule 6 never applied.*
11. **(file)** Re-check frontmatter `dataSources` against the roots (§4a rule 5),
    replicating `resolveDataSourcePath(declared, dirname(absPath))`
    from [src/parser/markdown.ts](../src/parser/markdown.ts) including
    its `~` expansion. Forward the values themselves verbatim.
12. Project and interpolate `config` and `parameters` (below).
13. Ensure the server is up (§5), then send.

`parseTestContent` gives unexpanded `steps`, `stepLines`, `sections`
(already `matchText`-keyed, on a null-prototype object —
`JSON.stringify` handles that), `config`, `parameters`, `rawSteps`,
`frontmatter`. **It does not `path.resolve` its `filePath`** (unlike
`parseTestFile`), and that value becomes `testFilePath`, every
`frame.uri`, the section cycle key, the cache anchor and the report
name — hence step 2.

**Every `parseTestContent` throw is a pre-flight `isError:true`**
(no run exists), message `Cannot parse <abs path>: <thrown message>`.
It throws on duplicate/reserved/empty section names **and** on
step/line mismatch (marked-vs-scanner drift), which a file with a
numbered line inside a code fence will hit.

| Field | Source | Note |
| --- | --- | --- |
| `steps` | parser | |
| `sourceLines` | parser's **`stepLines`** | **renamed on the wire** — the allow-list accepts `sourceLines` and silently ignores `stepLines`. It also drops the array unless arity matches **and every element is finite and > 0**; the parser can legitimately emit `0`. If any element ≤ 0, **omit `sourceLines` entirely** plus a `warnings[]` note. In that path the fold cannot recover `sentIndex` at all when anything expanded (`sourceLineFor` then returns *expanded* index + 1), so rows get `sentIndex: null` and omit `text` whenever `skillsDir`/`sections` were sent |
| `sections` | parser | `ParsedSection`'s extra `rawSteps` is *not* an error (`validateSectionEntry` never rejects unknown keys) — strip it client-side for payload size only. Server 400s on `steps`/`stepLines` skew *within* a section |
| `env` | composed map (§4) | how the *project's* `AI_API_KEY`/`AI_MODEL` reach the session; without it runs silently use the *server process's* AI key and model |
| `envName` | step 10 | drives `${env.X}`/`${data.X}`. Unrelated to `env`. A frontmatter-derived name is validated identically, so §7's missing-`.env.<name>` row covers `env: uat` with no `.env.uat`. An env is **never inferred** from the presence of `.env.*` files; absent ⇒ omit the field |
| `config` | `## Config`, projected; tool arg merged over it **per key**; the merged result then interpolated | below |
| `parameters` | `## Parameters` as the base; tool arg overrides **per key**; the merged result interpolated | undeclared keys are still sent, and produce the §7 warning on `run_test_file` only |
| `dataSources` | frontmatter, **verbatim** | server resolves against `dirname(testFilePath)`; throws if one is named `env` or `data`. **Silently ignored unless `envName` is sent** — declaring them with no resolvable env name is a `warnings[]` entry |
| `skillsDir`, `toolsDir` | `steptix.config.json`, else the `defaults.ts` literals (`./skills`, `./tools/src`), resolved absolute, sent only if present on disk | the literal fallback is required: a project that omits `tests.skillsDir` but *has* `./skills` would otherwise get no skills dir and every `[skill: x]` would ship to the AI as prose. This repo's own config declares both, so the live smoke would not catch it |
| `cacheEnabled` | `cache.enabled === true`, overridden by `## Config: cache:` — **mirror `resolveCacheOverride`'s value set** (`on\|true\|yes\|enabled` / `off\|false\|no\|disabled`), not just `on\|off` | without it a test saying `cache: off` gets cached MCP runs |
| `testFilePath` | absolute | |

**`config` is a projection, not a pass-through.** The parser's
`TestConfig` has `cdp?: string` + `cdpTab?: string`; the wire wants
`cdp?: { port: number; tab?: string }`. `api-server.ts` casts with **no
validation** and `launchBrowser` branches on bare truthiness, so
forwarding the parsed shape makes `## Config: cdp: 9222` take the CDP
branch with `port === undefined`. Send `{ baseUrl?, timeout? }` plus
`cdp: { port: Number(cfg.cdp), tab: cfg.cdpTab }` only when `cdp` is an
integer in 1–65535; **anything else is a pre-flight error naming the
value**, mirroring `parseCdpOptionsFromTestConfig` (module-private, so
this is a mirror, not an import). `cdpTab` without `cdp` is dropped
silently. `TestConfig.consoleLogLevel`/`serverFileLogLevel` belong to
`logging`, which we do not send (§2), so they are **not forwarded** —
note it in `warnings[]` when a test declares them. The **tool argument**
`config` is `{ baseUrl?, timeout? }` only — no agent-supplied `cdp`,
since that selects a live browser to attach to.

**Interpolate `config` and `parameters` client-side.** The server
interpolates only *steps* — `baseUrl` goes straight to `page.goto` and
`request.parameters` are merged verbatim — so `- baseUrl: $BASE_URL`
would navigate to the literal. Call
`interpolateEnvData(value, { env: composed, envName, filePath: absPath })`
from [src/parser/interpolate-env-data.ts](../src/parser/interpolate-env-data.ts)
— **not** `applyEnvDataInterpolation`, which is module-private — and
additionally resolve whole-value `$VAR`. Each existing client covers one
syntax (the CLI `${env.X}`/`${data.X}`; Steptix whole-value `$VAR`);
the MCP deliberately covers both, which also means `- baseUrl: $BASE_URL`
behaves differently under `steptix run`.

Four consequences to state rather than discover:

- **`interpolateEnvData` throws** on an unknown reference. That throw is
  a pre-flight `isError:true` carrying the message verbatim (CLI
  fail-fast). Catching and passing through is forbidden.
- **An unresolvable whole-value `$VAR`** is *not* an error — it stays
  literal with a `warnings[]` entry, matching Steptix's `resolveValue`.
  The asymmetry with `${env.X}` is deliberate: `$FOO` is ambiguous with
  ordinary prose in a way `${env.FOO}` is not.
- **`${data.X}` / `${<source>.X}` cannot be resolved client-side** —
  the pattern only matches when `ctx.data`/`ctx.extraData` are set, and
  we forward `dataSources` for the server instead. Any surviving
  `${data.` or `${<source>.` in `config`/`parameters` is a `warnings[]`
  entry naming the placeholder.
- **With no `envName` the server does not interpolate steps at all**
  (`envDataCtx` is built only when an env bundle exists). So a
  `run_steps` call with no `env_name` ships `${env.PASSWORD}` to the AI
  as a literal: if no env name resolves and any step, config or
  parameter contains `${`, add a `warnings[]` entry naming the
  placeholders.

**Do not use `resolveParameters`** ([src/parser/parameters.ts](../src/parser/parameters.ts)),
despite the matching name: it resolves `$VAR` against `process.env`
rather than the project map, and **prompts on stdin/stdout by default**
— which on a stdio transport writes `Enter value for "x":` into the
JSON-RPC channel and steals stdin from the transport.

**Config source is `steptix.config.json`, read directly — not
`loadConfig`**, which always populates relative `tests.skillsDir`/
`toolsDir` and folds `process.env` (`AI_API_KEY`, `AI_MODEL`,
`STEPTIX_SERVER_API_KEY`) into its result, so "the project's config" would
include the MCP process's environment. The ban is on the *loader*, not
its default literals, which §3's table and `list_test_files` both reuse.

**The first-request `config` rule.** The server accepts `config` only on
the request that creates a session, and *throws* — but on the streaming
path that throw is caught **after** headers flush and surfaces as an
`output` event plus `done: error` over HTTP **200**, so the 400 an
earlier draft planned to catch is unreachable. The MCP process is
stateless while `mcp:` sessions outlive it, so the ordinary second call
on a file hits it. Both run tools take `config` and are affected.

Design: **no `GET /sessions/:id` probe** — that route returns a live
base64 screenshot, so probing would drive a Playwright screenshot on
every call, can block behind a busy page, 404s for a closed session the
server would recreate anyway, and is a TOCTOU. Instead track "first call
for this session id **in this process**" in the §6 registry, send
`config` only then, and on a run whose error text contains
`Config can only be provided on the first request` (it arrives prefixed
`Server error: `) retry **once** without `config`. The retry cannot
double-execute: the throw precedes both `createSession` and the
`queueTail` enqueue — verified. **Read and set the flag inside the
critical section** — read outside it and two serialized calls both send
`config`, making the second take the retry path needlessly. Mark
"configured" only once the stream produced at least one event, so a
connect failure does not burn it, and also on a successful retry. On a
successful retry report `sessionCreated:false, configApplied:false`. A
test pins the server's exact message so a future server-side change
breaks loudly instead of silently disabling the retry. *(Making the
server tolerant would delete this mechanism and is the recommended
follow-up; out of scope.)*

**`warnings[]` from parameters** is scoped: the undeclared-parameter
warning applies to `run_test_file` only (`run_steps` has no
`## Parameters` block), and the `{{name}}`-left-literal scan covers only
the file's own steps and sections — skill bodies expand server-side and
are invisible to the client. State the partiality.

### 4. Server discovery + env resolution

The composed map is `readDefaultEnvVars(root)` — always — with
`readEnvFileVars(envName, root)` layered on top **when a name resolves**
(§3 step 10). Both are exported from
[src/env/loader.ts](../src/env/loader.ts); `readEnvFileVars` throws
`Environment file not found: <abs path>`, verbatim §7's wording.
Precedence: `.env.<name>` over `.env`.

Do **not** follow `resolveEnvBundle`
([src/env/resolve-bundle.ts](../src/env/resolve-bundle.ts)): it seeds
the map with the entire `process.env` and reads neither file unless
`envName` is set. Following it would return `{}` for a `run_steps` call
with no `env_name` and otherwise ship the whole MCP host environment as
the request's `env` field and into the spawned child — the egress §5
arm 2 exists to prevent. Cited as contrast, not as the recipe.

**Discovery-only fallback.** `SERVER_URL` and `STEPTIX_SERVER_API_KEY` may also
come from `process.env`, at **lowest precedence** (`.env.<name>` >
`.env` > `process.env`) and **never merged into the `env` map sent to
the server**. This is required, not a convenience: for Codex CLI and
Copilot CLI the host config's `env` block is the only per-server
configuration surface a user has, and `STEPTIX_MCP_ROOTS` is already read
from exactly that channel — refusing the other two would be
inconsistent and would make those hosts unconfigurable.

Note `steptix stop` does neither — it reads `process.env` and derives its
URL from `loadConfig().server.host/port`, never `SERVER_URL`. No
`SERVER_URL` in scope ⇒ pre-flight error naming both files and the env
var. **No `STEPTIX_SERVER_API_KEY`** ⇒ its own pre-flight error (§7): `serve`
hard-exits before binding without it, so otherwise a missing key costs a
full 20 s poll and reports "auto-start failed" instead of the truth.

### 4a. Roots confinement

Allowed roots: the **`path.delimiter`**-separated `STEPTIX_MCP_ROOTS` if
set, else the MCP process cwd. **Required for Codex CLI and Copilot
CLI** — machine-global configs whose spawn cwd is not the project. It is
**not** set in the checked-in `.mcp.json`: the value is an absolute
path, so a committed one points at someone else's disk in every other
clone, and Claude Code expands only `${VAR}`, not a workspace token.
`.vscode/mcp.json` sets `"STEPTIX_MCP_ROOTS": "${workspaceFolder}"`, which
VS Code does expand.

**Selecting `project_root`** (distinct from the allow-list): `path`'s
bounded upward walk for `run_test_file`; else the given `project_root`;
else cwd when inside or equal to an allowed root; else the single
allowed root when exactly one is configured; else invalid-params naming
`STEPTIX_MCP_ROOTS` and the candidates. When both `path` and
`project_root` are given, `path` must be inside `project_root`.

**Confinement algorithm**, each rule closing a real hole:

1. **`fs.realpathSync.native` both sides** before comparing —
   `path.resolve` does not follow symlinks, so a symlink inside an
   allowed root pointing at `~/.ssh` would otherwise pass; `.native`
   also canonicalises win32 case and 8.3 short names (`C:\PROJ~1`).
   `ENOENT` on a supplied `path` maps to §7's missing-file row; `ENOENT`
   on a `STEPTIX_MCP_ROOTS` entry is a startup error naming the variable.
2. **Segment-boundary compare**, not `startsWith` — which would let
   `C:\proj-evil` through an allowlist of `C:\proj`.
3. **Case-insensitive on win32**, case-sensitive elsewhere.
4. **Bound the `steptix.config.json` upward walk at the allowed root.** The
   server's own `resolveProjectRoot` walks 50 levels to the filesystem
   root; unbounded here it would land *outside* confinement and pull
   `skillsDir`, `toolsDir` and `.env` from there — a straight bypass.
5. **Re-check every config- or frontmatter-derived path** — `skillsDir`,
   `toolsDir`, `tests.dir` (step 6) and frontmatter `dataSources`
   (step 11, after the parse that yields them). `{"tests":{"toolsDir":
   "../../../x"}}` resolves outside, and `dataSources` are forwarded
   verbatim for the server to resolve with no confinement of its own.
6. **`env_name` must match `/^[A-Za-z0-9._-]+$/`** — no separators, no
   `..`. `readEnvFileVars` does `path.resolve(projectRoot, '.env.' +
   envName)`, so `../../../secrets` reads an off-root file whose parsed
   contents §3 then ships as the request's `env` field, straight into
   the interpolation scope. Realpath-confine the resolved file too.
   Applies to a frontmatter-derived name identically.

### 5. Auto-start

Probe with `probeHealth` ([src/server/health.ts](../src/server/health.ts)).
**Only one change to it: an optional `AbortSignal`**, composed as
`AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])` — available
at the declared `engines.node >= 18.17.0` floor, and verified not to
leak listeners across ~120 composites (Node tracks dependent signals
internally, so the extension's hand-rolled `withTimeout` is unnecessary
here; it exists only because VS Code ships pre-18.17 Node).
`exactOptionalPropertyTypes` is on, so build the `RequestInit`
conditionally rather than passing `{ signal: maybeUndefined }`.

**The trap:** `probeHealth` folds *every* fetch rejection into
`{kind:'down'}`, **including an abort**. The spawn-poll loop must check
`signal.aborted` **before** interpreting a `down`, or a cancelled call
reports an auto-start failure instead of a cancellation.

*(An earlier draft added a `foreign` arm. Dropped: the tree below
refuses `foreign` and `unrecognized` identically, so it buys nothing —
`unrecognized.detail` already carries `service is "x", not
"steptix"` — and adding it would silently regress two shipped
behaviours, because `steptix status` and `steptix stop` test
`kind === 'unrecognized'` with an `if`, not an exhaustive switch. A
missed update makes `status` exit 1 instead of its documented 2, and
makes `stop` fall past its refusal and POST `STEPTIX_SERVER_API_KEY` to the
foreign process.)*

**`SERVER_URL` validation.** Refuse with a §7 row, *before the probe*, a
path component (`probeHealth` appends `/health` after
`normalizeBaseUrl`, so `http://h:3100/api` probes `/api/health`, 404s,
and lands in arm 2 with a misleading message).

Two more are refused **only on the down-and-about-to-spawn path**, not
up front — a reachable server that arm 1 accepts must keep working, and
a Steptix behind an HTTPS reverse proxy is a configuration Steptix
already allows:

- a non-`http:` protocol — `serve` has no TLS, so spawning for an
  `https:` URL yields a plaintext server whose every probe fails,
  costing 20 s and reporting nothing useful;
- an empty port — `new URL('http://localhost/').port === ''`, and
  `serve` parses `--port` with bare `parseInt`, so `NaN` reaches
  `app.listen` and throws `ERR_SOCKET_BAD_PORT`. Do **not** default to
  80/443.

Decision tree:

1. Healthy + `service` matches ⇒ proceed.
2. `unrecognized` (foreign service, non-2xx, or non-JSON) ⇒ pre-flight
   error naming the port and what it reported. **Never spawn, never
   proceed.** *(Changed from an earlier draft's "probably an older steptix
   server, proceed": our next act sends `STEPTIX_SERVER_API_KEY` **and the
   entire composed `.env` map** as `env` — for this repo, AI, banking
   and GitHub credentials. `steptix stop` already checks `service` before
   sending merely the key.)*
3. Down + host not loopback ⇒ pre-flight error. Loopback set is exactly
   `localhost`, `127.0.0.1`, `::1`, `[::1]` — **not** `0.0.0.0`, and not
   the rest of `127/8`.
4. Down + loopback ⇒ spawn.

```
process.execPath --inspect=0 <dist>/index.js serve \
    --host <normalized> --port <from SERVER_URL> --idle-timeout 60
```

```ts
const child = spawn(execPath, args, {
  cwd: projectRoot, detached: true, shell: false, windowsHide: true,
  stdio: ['ignore', fd, fd], env: mergedEnv,
});
child.on('error', (err) => appendFileSync(logPath, String(err)));
child.unref();
```

**`unref` is not a `spawn` option** — it is `child.unref()`, and Node
silently ignores the unknown key. Measured with exactly this option set:
without the call the parent stayed alive **5046 ms**, the child's whole
lifetime, versus **0 ms** with it. Since the auto-started server lives
up to the 60-minute idle timeout, an MCP process that started one would
**never exit on stdin close**, orphaning a process per host session.

Every part of that is load-bearing:

- **`--host` must be normalized**, and this repo is the proof. Its
  `.env` says `SERVER_URL=http://localhost:3100` while its
  `steptix.config.json` says `"host": "127.0.0.1"`. Passing `--host
  localhost` makes `serve` override the config and `app.listen(3100,
  'localhost')` resolve via `dns.lookup`, which on this machine returns
  `::1` first — so the child binds **IPv6 loopback only**. The MCP's own
  `fetch` still works (happy eyeballs), so the smoke test passes, but
  `steptix status`/`steptix stop` derive their URL from
  `loadConfig().server.host/port` = `http://127.0.0.1:3100`, get
  connection-refused, and report **"not running"** — an MCP-started
  server unstoppable from the CLI. Normalize `localhost`/`127.0.0.1` →
  `127.0.0.1` and `::1`/`[::1]` → `::1`, stripping brackets
  (`new URL('http://[::1]:3100').hostname` returns them, and
  `app.listen` rejects that).
- **`shell: false`** (the default, stated because the extension uses
  `shell: true`): its input is a user-configured command *string*; ours
  is a known argv array, and `process.execPath` is routinely
  `C:\Program Files\nodejs\node.exe`, which `shell: true` would require
  quoting.
- **`windowsHide: true`** or a console window flashes on every
  auto-start.
- **An `'error'` listener is mandatory.** Node reports a missing `cwd`,
  EPERM and EACCES asynchronously on the child's `'error'` event, and
  with no listener EventEmitter rethrows it as an uncaught exception —
  in an MCP server that drops the host connection entirely. Attach one
  that appends to the log so §7's tail explains it.
- **Explicit `env`.** `serve` hard-exits before binding when
  `STEPTIX_SERVER_API_KEY` is unset, and `loadDefaultEnvFileSync` reads only the
  base `.env` — never the overlay — and does not override keys already
  in `process.env`. Inheritance alone gives either an instantly-dead
  child or a live child holding the *base* key while the client sends
  the *overlay* key: a permanent 401. On win32, merge keys
  case-insensitively — `process.env` reads case-insensitively but
  spreading preserves the parent's casing, so a `STEPTIX_SERVER_API_KEY` vs
  `server_api_key` collision would silently pick a winner.
- **`--inspect=0`.** Both clients share one server; whoever starts it
  decides whether Steptix's tool step-into works (`/health` reporting
  `inspector: null` makes the extension refuse to attach).

**Resolving `<dist>/index.js`** — reuse the trick
[src/utils/version.ts](../src/utils/version.ts) already uses, which
works for checkout, `tsx`-from-source and npm-installed alike because
src and dist depths match:
`path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js')`.
A bare `../index.js` resolves to `src/index.js` under `tsx` — the repo's
own dev loop — which does not exist, giving MODULE_NOT_FOUND and a 20 s
timeout with a misleading message. Add an `existsSync` pre-check with a
pre-flight error naming `npm run build`, so §8's "fresh clone is broken
until build" caveat fails in milliseconds with the right message.

Poll `/health` every 250 ms with a **1 s per-probe budget**
(`HEALTH_PROBE_TIMEOUT_MS`, ported with the other constants — a 2 s
default against a mid-boot server would make the 250 ms cadence
meaningless) up to a 20 s total, honouring the abort signal.
**Poll rather than watching `exit`** for the reason the extension
documents: in a two-window race the loser's child dies of EADDRINUSE and
the poll goes green anyway on the winner's server, so the race
self-resolves. `--idle-timeout` is in **minutes**; 60 is a deliberate
product choice — long enough that an agent returning after a break
still has its session, at the cost of holding a browser for an hour
after one walks away, and it also decides whether Steptix finds a live
server later.

**Failure suppression** is a **module-level** `Map<string, number>`
keyed by `canonicalServerKey(url)` (§6) — same reasoning as §6's mutex
("not per-`McpServer`, or the seam test passes while production keys
collide") — cleared on success. A *suppressed* attempt re-reads the log
tail and says "a start attempt failed Ns ago; not retrying for another
Ms", since §7's row demands a tail and a suppressed attempt has no fresh
spawn.

**Single-flight.** §6's mutex is entered *after* pre-flight, and
auto-start *is* pre-flight, so two parallel tool calls against a down
server would both probe, both see `down + loopback`, and both spawn.
Wrap `ensureServerReady` in a single-flight promise in the module
registry, keyed by the same `canonicalServerKey`. Two rules make it
safe:

- **The shared spawn/poll runs under an `AbortController` the registry
  owns**, and each caller `Promise.race`s the shared promise against
  its own `extra.signal`. Passing a caller's signal into the shared
  work would let one cancellation fail every other waiter that never
  cancelled — and §5's "check `signal.aborted` before interpreting a
  `down`" would then report a cancellation the survivor did not
  request. A cancelled caller walks away; the start continues; later
  callers get a ready server.
- **Delete the entry on settle**, success *and* failure. A retained
  rejection would poison the URL for the life of the process and
  silently override the 60 s backoff, which is the single suppression
  mechanism.

**Log file** `<project_root>/.steptix/mcp-server.log`:
`mkdirSync(dirname, {recursive:true})`, then
`fs.openSync(logPath, 'a', 0o600)`, pass the fd as `stdio: ['ignore',
fd, fd]`, and `closeSync` it in a `finally` (the child holds its own
dup). Truncate at open above 5 MB. **`0o600` is inert on win32** —
measured, the file lands mode `666`, because Node on Windows can only
express the read-only bit — so on this project's primary platform the
log is readable by every user on the box. Keep the mode (correct and
free on POSIX) but do **not** cite it as the mitigation that justifies
logging resolved values. The mode also applies only at creation; an
existing looser file keeps its permissions. Add `.steptix/` to
`.gitignore` (only `.steptix-tool-cache/` is listed today).

**Idle-timer interaction.** A long run is pinned by `runsInFlight()`
(server-lifecycle §3's maintained counter), not by MCP traffic, so a
90-minute run is never reaped mid-flight. Conversely an agent leaving
more than the idle window between calls loses the session and its
browser — verification rule (4) depends on this, so `run_steps`'
description says it.

**What to port from the extension's `server-manager.ts`** (it is *not*
importable — separate bundle, and editing it trips the extension-bump
rule; everything is a port):

- *Port near-verbatim*: `isLoopbackUrl`, `openLogFile`, `readLogTail`,
  `AutoStartGuard`, the `startServerAndWait` poll-loop shape, the
  `child.on('error')` handler, and the timing constants.
- *Do NOT copy*: `HEALTH_SERVICE_ID` and `normalizeBaseUrl` —
  `src/server/health.ts` owns these and a second copy is the drift its
  own header warns about; `HealthProbeResult`/`defaultHealthProbe` —
  we use `health.ts`'s union and refuse the `foreign` arm;
  `withTimeout` — obsolete given `AbortSignal.any`;
  `readAutoStartSettings` — VS Code-coupled. **`describeHealth` and
  `decideServerAction` are the dangerous ones**: both map `unknown` to
  *proceed on the legacy path*, precisely what arm 2 reverses. Copying
  either silently reinstates what this spec forbids.

### 6. Streaming, cancellation, concurrency

**SSE reader** — mirror the semantics of the (banned) house
implementation exactly: buffer; split on `\n`; strip a trailing `\r`;
skip `:`-prefixed comment lines (the server sends `: keep-alive\n\n`
every 25 s); strip one leading space after the field colon; join
multiple `data:` lines with `\n`; a blank line flushes. **Dispatch on
the payload's `type`**, not the `event:` field. An unparseable or
unrecognised frame is dropped and recorded — the reader returns a
`dropped: string[]` alongside the events, which `run-fold.ts` merges
into `warnings[]` (the reader lives in `api-client.ts` and cannot reach
`warnings[]` itself).

**Progress** when the host supplied `extra._meta.progressToken`:
`extra.sendNotification({ method:'notifications/progress', params:{
progressToken, progress, total?, message? } })`. `progress` counts
**terminal events only** (`step:pass`/`step:fail`), with the step text
in `message` — counting every event would exceed `total` and render
past 100%, while counting "steps done" on both `step:start` and the
terminal event would repeat a value and violate MCP's
must-increase rule. `total` is the sent step count **only when neither
`skillsDir` nor `sections` was sent**. `sendNotification` silently
no-ops once the request is aborted. **No token ⇒ no notifications**, and
the run rides the host's fixed timeout — the real risk behind §Risks.

**Cancellation** arrives as `extra.signal`; abort the SSE request. The
server treats disconnect as a run abort. A cancelled call returns
nothing, so: session and browser **stay open** (agents use
`close_session`), the report is written *after* the abort (hence
`get_last_run`'s poll), and the signal must also cover the probe/spawn
phase. Host closes stdin mid-run ⇒ process exits, socket dies, server
aborts.

**Concurrency.** Hosts fan out parallel tool calls, and
`run_test_file`'s default id is path-keyed, so two parallel calls on one
file collide by default. The server serializes per session on
`session.queueTail`; the second blocks, then runs against the first
run's mutated page and scope. So serialize **in-process**: a
**module-level** registry (not per-`McpServer`), keyed
`${canonicalServerKey(serverUrl)}::${sessionId}`.

**`canonicalServerKey` is one exported function**, used by the mutex,
the §5 backoff map and the §5 single-flight alike — three key
derivations in one module is how they drift apart. It applies §5's host
normalization (`localhost`/`127.0.0.1` → `127.0.0.1`; `::1`/`[::1]` →
`::1`, brackets stripped), then `normalizeBaseUrl`, then lowercase.
Lowercasing alone is not enough: it maps `HTTP://LOCALHOST:3100` to
`http://localhost:3100` but leaves `localhost` and `127.0.0.1` as
different keys, splitting one session into two mutexes and — worse —
two "first call" beliefs, which misfires §3's config retry. It lives in
**W1** (`registry.ts` or a small `src/mcp/url.ts`) even though W4 owns
the host normalization, since W1 otherwise cannot compile its own key
function. One
never-deleted entry per key holding `{ tail, configured }`: the mutex
tail is replaced per call while `configured` must persist. Shared by
both run tools, entered **after** pre-flight so a bad root fails fast.
`queuedForMs` counts mutex wait only. `registry.ts` exports a **reset**
for the seam tests and is part of `deps`.

**Accepted limitation:** the mutex does not help *across* processes, and
two MCP processes on one repo is normal. Session lookup, the config
check and `createSession` all run *outside* `queueTail`, so two
concurrent first-requests on the same new id launch **two browsers** and
orphan one. Fixing that means moving creation into the queue
server-side — out of scope, documented so it is a decision.

### 7. Errors

No TB codes. Pre-flight failures are `{content:[text], isError:true}`
and are **returned, never thrown** (the SDK converts a throw into the
same shape, so the choice is arbitrary — but one convention keeps the
tests honest). Message content lives in **`src/mcp/errors.ts`**, one
exported builder per row plus a `preflightError(text)` wrapper; without
a single owner the messages drift across three modules and the tests pin
a dozen literals.

| Condition | Message names |
| --- | --- |
| path/root outside allowed roots; unresolvable `project_root` | the root, the candidates, and `STEPTIX_MCP_ROOTS` |
| no `steptix.config.json` within the root | `STEPTIX_MCP_ROOTS` first, then every directory searched |
| no `SERVER_URL` | both env files and the env var |
| no `STEPTIX_SERVER_API_KEY` | both env files and the env var |
| `SERVER_URL` non-`http:`, portless, or path-bearing | the URL and the rule |
| unrecognized service on the port | the port and what it reported |
| server down, remote URL | the URL; only loopback auto-starts |
| `dist/index.js` missing | the resolved path and `npm run build` |
| auto-start failed / suppressed | the command, the log path, the log tail (and, when suppressed, the remaining backoff) |
| 401 | **both** key sources |
| relative path / missing file / `type: skill` / zero steps | the path and the rule |
| `parseTestContent` throw (bad section name **or** step/line mismatch) | `Cannot parse <abs path>: <thrown message>` |
| `env_name` invalid (rule 6) or no `.env.<name>` | the value or the file looked for |
| `interpolateEnvData` throw | the thrown message verbatim |
| non-integer / out-of-range `cdp` | the value |
| `list_sessions` timeout | the 5 s budget and the likely cause |

Behaviours stated in tool descriptions because they surprise: an unknown
`session_id` on a run tool is **not** an error (the server auto-creates
it); `close_session` and `get_last_run` succeed on unknown ids;
undeclared `parameters` pass through unused and a declared-but-missing
one leaves `{{name}}` literal — both in `warnings[]` per §3.
`run_test_file` pre-scans for `[input:`/`[interactive]` main-flow steps
and reports them in `warnings[]` — not because the fold would mislabel
them (§2 maps them to `skipped`) but so the agent knows before running
that part of the test cannot execute unattended.

### 8. Packaging, docs, host setup

- Ships in the main package via `npm run build`; hosts execute `dist/`,
  so rebuild before every smoke. New deps:
  **`@modelcontextprotocol/sdk@^1.29.0`** and **`zod@^4`** — the SDK
  marks zod a **non-optional** peer (and `@cfworker/json-schema` an
  optional one, which we need not declare), so an undeclared zod
  resolves at runtime but can swing majors on a lockfile refresh. Pin
  the SDK: `@modelcontextprotocol/server@2.x` is a separate in-progress
  rename. Commit the lockfile in the same change. *(Measured: a warm
  SDK import is ~250 ms and pulls in ajv but not express/hono/jose.)*
- **No extension bump** — nothing under `steptix-*`/`runner-core` is
  touched.
- `.mcp.json` and `.vscode/mcp.json` checked in (only the latter sets
  `STEPTIX_MCP_ROOTS`, via `${workspaceFolder}`); README with copy-paste
  config for all four hosts. Four caveats: a fresh clone is broken until
  `npm run build` (the configs point at gitignored `dist/`); the Codex
  VS Code extension has an open bug detecting `config.toml` MCP servers
  (verify via Codex CLI first); Windows Codex setups may need
  `startup_timeout_ms` raised; and **if you auto-start via MCP, use
  `steptix status --url $SERVER_URL`** — `status`/`stop` otherwise derive
  their target from `steptix.config.json`, which can disagree with
  `SERVER_URL` on host *or* port.

## Out of scope

- Streamable HTTP transport, ChatGPT cloud connectors, tunnels, OAuth.
- Async job model; debug protocol; exposing `frame:*` events.
- Glob/batch `run_test_file`; MCP resources/prompts; a `stop_server`
  tool; per-session TTL.
- Server-side changes beyond `probeHealth`'s optional `AbortSignal` — in
  particular, making the config-on-existing-session check tolerant, and
  moving session creation inside `queueTail`. Both are recommended
  follow-ups (§3, §6).
- Any change to the Steptix extensions, Monaco, or `runner-core`.

## Composition

- `server.ts` — `createMcpServer(deps): McpServer`; `main()` creates it,
  redirects the global console, connects a `StdioServerTransport`, exits
  on stdin close.
- `tools.ts` — `registerTools(server, deps)`.
- `deps = { createApiClient, ensureServerReady, resolveProject,
  registry }`.
- `createApiClient({ baseUrl, apiKey, fetchImpl? })` is a **factory**,
  not an instance: base URL and key are per-project, so one injected
  client cannot serve two roots, and the real-app seam test needs one
  pointed at an ephemeral port.
- `errors.ts` — the §7 builders. `usage.ts` — `MCP_USAGE`.
  `registry.ts` — mutex, first-call bookkeeping, auto-start
  single-flight and backoff, plus a test reset.

## Tests

House pattern: there is **no `supertest`**, and `createApiServer`
constructs its own `SessionManager` with no injection point. Existing
tests use `listenOnRandomPort()` over `node:http` plus `vi.mock` of nine
deep modules — see [tests/api-server.test.ts](../tests/api-server.test.ts),
already copied near-verbatim into three sibling files. **Budget for a
fifth copy**, or factor the mock *factories* into `tests/helpers/` (the
`vi.mock(path, factory)` calls themselves are hoisted and must stay in
the test file). Note `tsconfig.json` excludes `tests`, so `npm run lint`
does not typecheck them.

### Unit / seam (vitest)

- **Assembly goldens**: frontmatter env + dataSources; inline sections;
  `## Config` with `cdp` projection, `cache:` in both value sets, and
  `$VAR`/`${env.X}` baseUrl; `## Parameters` in both syntaxes with a
  tool-arg override; `type: skill`; zero steps; dataSources with no env
  name (⇒ warning); `stepLines` containing `0` (⇒ `sourceLines` omitted
  + warning); a config omitting `skillsDir` where `./skills` exists (⇒
  default used); **a test whose env comes only from frontmatter `env:`**
  (⇒ `.env.<name>` actually loaded — the step-10 ordering); both
  `parseTestContent` throw classes.
- **Interpolation**: unknown `${env.X}` ⇒ pre-flight error verbatim;
  unresolvable `$VAR` ⇒ literal + warning; surviving `${data.` ⇒
  warning; no `envName` + `${` present ⇒ warning.
- **Fold**: root-vs-expanded both ways; `line → sourceLines` recovery;
  a section invoked twice (no map collapse); `frame:push` ancestry
  giving `sentIndex`; **a branched group at the end of a passing run ⇒
  `unknown`, never `not-run`**; trailing `not-run` on a failed run;
  started-without-terminal ⇒ `unknown`, `durationMs: null`; synthetic
  rows landing at their `sentIndex` position; `skipped`; error
  precedence with no `step:fail`; `messages[]` window covering a
  pre-`step:start` error; `reportPath` off `done`; a failed
  `get_last_run` poll leaving `status` untouched; screenshot opt-in,
  prefix strip, size drop; duplicate capture last-wins.
- **Transport failures**: every row of §2's table, including
  reader-ends-without-`done` ⇒ `streamDropped`, and `read()` throwing
  under our own abort ⇒ cancellation not drop.
- **Output validation**: a deliberately malformed fold produces a
  **valid** `status:'error'` result with the diagnostic in `warnings[]`,
  never `isError:true`.
- **MCP seam** (`InMemoryTransport`, injected client factory): all
  **15** tools; progress emitted with a token and `progress`
  strictly increasing and never exceeding `total`; the no-token case
  driven by calling `callTool` **without** `onprogress` (which is what
  creates the token); cancellation aborts and leaves the session open;
  same-session concurrent calls serialize and report `queuedForMs`;
  `content[0]` text summary present; the `isError` contract — assert
  **`toBeFalsy()`**, because the SDK leaves `isError` **`undefined`**
  on success, not `false`. Use `{ timeout: 30_000 }` on any test that
  exercises `get_last_run`'s ~12 s poll, as existing SSE tests do.
- **Content blocks carry the data** — a guard over **every registered
  tool**: call each one successfully and assert some `content` block is
  exactly `JSON.stringify(structuredContent)` (equality, not
  `toContain`, so pretty-printing fails it too). The per-tool arguments
  table this needs is itself the opt-out the guard exists to prevent, so
  assert **its keys equal `listTools()`** — the trick
  `mcp-schema-dialect.test.ts` already uses for schemas. Plus one
  explicit case that `get_page_content` does **not** ship the page twice
  in `content`. It needs a real project on disk (`list_test_files`
  confines `tests.dir` against `allowedRoots()`, and `run_test_file`
  reads a file), so: tmpdir + `steptix.config.json` + `STEPTIX_MCP_ROOTS`, as
  the real-app seam does.
- **Retry-without-config**: first call sends config, second omits; a
  session recreated out-of-process triggers the retry; a connect failure
  does not burn the "configured" flag; the pin test on the server's
  exact message.
- **Foreign session refusal**: non-`mcp:` id refused;
  `allow_foreign_session` permits.
- **Real-app seam** (client-seam rule): drive **`run_test_file`**
  through the real `createApiServer` app over HTTP with deep modules
  mocked. The tmpdir fixture needs a `steptix.config.json` (§Locked "a
  project root is required") **and** `STEPTIX_MCP_ROOTS` pointed at it —
  the cwd default would refuse the tmp path. Two further traps: the
  existing logger mock omits `subAction`,
  `assertion`, `testStart`, `testEnd`, `tokenWarning`, `setVerbose`,
  `setLogCallback` and `traceOp`, all of which the assembly path can
  reach via the parser and skill expander — extend it or do not mock
  the logger here; and **port ordering** — mkdtemp → `createApiServer` →
  `listenOnRandomPort` → *then* write `.env` with the resulting
  `SERVER_URL` and a matching `STEPTIX_SERVER_API_KEY` → then call the tool.
  Scope note: with `step-executor` mocked, per-step statuses are
  synthetic, so this is a **field-drop** test (`envName`, `sections`,
  `sourceLines`, `dataSources` against the allow-list), not a fold test.
- **Roots confinement**: outside-cwd refused; `STEPTIX_MCP_ROOTS` honoured
  with `path.delimiter`; `..` refused; **symlink escape refused**;
  `C:\proj-evil` vs `C:\proj` refused; win32 case/short-name accepted;
  config walk stopping at the root; `toolsDir`, `tests.dir` and
  `dataSources` escaping refused; **`env_name` with a separator
  refused**, including a frontmatter-derived one; `project_root`
  selection across all five branches.
- **Auto-start**: healthy ⇒ no spawn; unrecognized ⇒ error with **no key
  and no env sent**; down+remote ⇒ error; down+loopback ⇒ spawn asserted
  to carry the **normalized** `--host` (`localhost` ⇒ `127.0.0.1`),
  `--port`, `--inspect=0`, `shell:false`, and the composed `env`;
  portless/`https:`/path-bearing `SERVER_URL` refused; missing
  `dist/index.js` refused fast; `spawn` emitting `'error'` does not
  crash the process; never-healthy ⇒ error with log tail; repeat failure
  suppressed with the backoff message; **two parallel cold starts spawn
  once** (single-flight); **caller A cancelling mid-spawn still leaves
  caller B with a ready server**; abort during poll ⇒ cancellation, not
  auto-start failure; **the MCP process still exits on stdin close
  after an auto-start** (the `child.unref()` regression); and
  `server_status` against a down server does **not** spawn.
- **401 path** names both key sources.
- **Entry hygiene** — three assertions that must live in **separate test
  files** (measured: `vi.resetModules()` + `vi.resetAllMocks()` do
  **not** clear the `vi.doMock` registry, so a mock registered in one
  test intercepts in the next): (a) with `argv[2]='mcp'`, playwright is
  **not** loaded and `setLogStream('stderr')` ran before
  `mcp/server.js`; (b) the **control case** with `argv[2]='run'` shows
  playwright *is* loaded — without it (a) passes for the trivial reason
  that the mock never resolved; (c) all 14 logger stdout sites go to
  stderr. Mock paths are resolved **relative to the test file**, so it
  is `vi.doMock('../src/mcp/server.js', …)` — the `./mcp/server.js` form
  does not intercept, the real `main()` binds stdio and the worker
  hangs. Note `setLogStream` is a **new export** absent from all seven
  existing `vi.mock('../src/utils/logger…')` blocks; add it there so a
  later `src/mcp/*` caller does not hit `undefined is not a function`.
  Additionally, a child-process check (`node dist/index.js mcp`,
  assert `createRequire(...).cache` stays at 0 entries — playwright is
  CJS and adds ~277) pins the **shipped artifact** rather than vitest's
  transformed graph.

Accepted without a test, explicitly: Windows detached-spawn semantics
(health-poll detection covers it), and cross-process session collision
(§6).

### Live (manual)

- Claude Code via this repo's `.mcp.json`: `run_steps`;
  `run_test_file` with an env; kill the server and watch a call
  auto-start it on the `SERVER_URL` port; **then `steptix status --url
  $SERVER_URL` and `steptix stop`** (verification rule 3); cancel mid-run
  then `get_last_run`; confirm `/health` reports an inspector so
  Steptix step-into still works.
- Codex CLI and Copilot CLI (both with `STEPTIX_MCP_ROOTS` set): register,
  list tools, one `run_test_file` each. Codex VS Code extension:
  attempt; a no-show is the known upstream bug.

## Risks / open

- **stdout pollution** — mitigated by the CLI bypass, the logger stream
  switch, the global console redirect and the ordering tests; residual
  risk from transitive imports that print at load.
- **Host timeouts without a `progressToken`** — accepted; the job model
  is the escape hatch.
- **The result payload is the real secret-egress path**, not the log:
  per-step `output`, `error`, `captures` and (opt-in) screenshots all
  reach the model provider. `include_screenshot` defaults off and
  `messages[]` is error/warn-only, but an agent that can run steps can
  navigate anywhere and read anything interpolated into them. The
  product working as designed — stated so it is a decision.
- **The `.steptix/` log is world-readable on Windows** (`0o600` is inert
  there) and holds step text and resolved values.
- **`messages[]` may contain another session's output** (process-global
  logger callbacks); best-effort, documented in the tool description.
- **Cross-process session collision** (§6) — two browsers, one orphaned.
- **Brittle substring match** on the config error (§3), mitigated by a
  pin test; the server-side fix is the recommended follow-up.
- **Windows detached spawn** — as the extension; health-poll detection.

# Plan

The spec is the contract. Where plan and code disagree, read the code
and update this doc.

## Workstream graph

```
W1 — entry bypass in src/index.ts (dynamic import, shebang, help guard,
 │   commander stub), setLogStream (14 sites via private Console),
 │   usage.ts, errors.ts, registry.ts, McpServer skeleton,
 │   deps (sdk@^1.29 + zod@^4 + lockfile), probeHealth AbortSignal
 ├──────────────────────────────┐
 ▼                              ▼
W2 — project.ts (roots §4a      W4 — server-start.ts (URL validation,
 │   incl. project_root          │   decision tree, spawn recipe,
 │   selection, config, env),    │   single-flight, backoff, log file,
 │   assemble.ts, goldens        │   .gitignore)
 ▼                              │
W3 — api-client.ts (SSE), run-fold.ts, tools.ts, schemas.ts  ◄──┘
 ▼
W5 — real-app seam + roots/401/entry-hygiene tests
 ▼
W6 — docs, .mcp.json, .vscode/mcp.json, live smoke
```

W2 and W4 are genuinely parallel — disjoint files, both depend only on
W1. W3 consumes both. PRs: **PR-1** = W1+W2+W4, **PR-2** = W3+W5,
**PR-3** = W6.

## Workstreams

## As built

Deviations from the spec above, and decisions the spec left open. Where these
disagree with the sections above, **these are what shipped**.

- **`canonicalServerKey` lives in `src/mcp/url.ts`** alongside
  `normalizeSpawnHost` and `isLoopbackHost` — the key derivation and the
  spawn-host normalisation are one rule seen twice, and W1 could not otherwise
  compile its own key function without W4.
- **Two probe budgets, not one.** The poll keeps the specified 1 s per probe,
  but the *arm-deciding* probe gets 2 s (matching `steptix status`/`stop`). Their
  failure modes are opposite: a slow poll probe costs 250 ms, while a busy
  server misread as `down` costs a doomed EADDRINUSE spawn plus the full 20 s.
- **The healthy arm clears the backoff record too**, not only a successful
  start, so a server that failed to start, came up by other means, and later
  fails again is not suppressed by a stale record.
- **`STEPTIX_SERVER_API_KEY` is pinned explicitly into the child's environment**
  rather than relying on the composed map: §4's discovery fallback means the
  key may live only in `process.env`, and that value is deliberately kept out
  of the map sent to the server — but client and child must still agree.
- **The base `.env` is not realpath-confined** (unlike `.env.<name>`). There
  is no caller-supplied component in its path, and a `.env` symlinked across
  checkouts is a setup the framework already supports.
- **A missing file is reported before confinement is checked.** §3's pinned
  order makes `realpath` the missing-file detector at step 2, ahead of the
  roots assertion at step 3, so a *nonexistent* path outside the roots reads
  as "No such file". This is a mild existence oracle — an agent can distinguish
  "absent" from "outside your roots" — and is accepted: neither answer reveals
  content, and reversing the order would mean reporting confinement failures
  for typos.
- **Progress survives the config retry.** The counter is not reset before
  re-streaming: the server raises the config error before enqueueing, so
  nothing has been counted yet, and resetting would send `progress` backwards
  if that ever changed.
- **Every result is `safeParse`d before return** via a `validated()` helper in
  `tools.ts`, and handlers set `isError: false` explicitly rather than leaving
  it undefined.
- **`src/mcp/` contains no `logger` or `console` calls at all.** Not a rule the
  spec stated, but it is the strongest available guarantee for both stdout
  hygiene and secret containment, and it is worth keeping that way.

### Found by the live smoke

Two bugs that the unit tests could not reach, because both need a real run:

- **`durationMs` was always 0.** The fold walks the collected event array
  *after* the stream closes, so every clock read in that loop returned the
  same instant — it was timing the loop, not the steps. The client now stamps
  an arrival time per event (`StreamResult.receivedAt`), and the absent case
  reports `null` rather than a fabricated zero.
- **A passing run carried an error message.** The runner retries a failed
  action and emits an error-level `output` per attempt, so a run that
  recovered still leaves error text in the stream; §2's precedence rule then
  surfaced it. A real DuckDuckGo run came back `status: "passed"` with
  `error: "Action failed [wait]: Timeout…"`. A passing run now reports no
  error; the text stays in `messages[]`.

### Found by the code review

Security, all fixed:

- **Three tools sent `STEPTIX_SERVER_API_KEY` to an unidentified listener.**
  `list_sessions`, `close_session` and `get_last_run` never reach
  `ensureServerReady`, so nothing checked `service` first — an agent's
  harmless "what's running?" probe would hand the key to a port squatter.
  `assertServerRecognized` now guards them, injected through `McpDeps` (the
  real one probes a real port, which would otherwise make the seam tests fire
  live requests).
- **A project `.env` could execute code in the spawned server.**
  `NODE_OPTIONS` honours `--require`/`--import`, and the child env was an
  unfiltered overlay. The boundary crossed matters: one server serves every
  project on that `SERVER_URL` and holds each one's `.env`, so project A got
  execution in the process later handling project B's credentials.
  `UNSAFE_CHILD_ENV_KEYS` now strips the loader-influencing names.
- **The auto-start failure message could quote a previous server's log** —
  which contains step text with `${env.X}` already resolved. `readLogTail` now
  takes an offset floor recorded when the attempt opened the log.
- **The base `.env` and `steptix.config.json` were the only unconfined reads.**
  A symlinked `.env` inside an allowed root could point at `~/.aws/credentials`
  and be parsed, shipped as the request's `env`, and interpolated into step
  text. Both are confined now, and a `STEPTIX_MCP_ROOTS` entry must be a
  directory.
- **`SERVER_URL` accepted a query, fragment or embedded credentials**; the
  check is now `origin`-based, and messages echo a credential-stripped form.
- **Foreign text was interpolated unbounded** into an error (a port squatter
  chooses `health.detail`) and into `captures` (the page under test chooses
  the value). Both are clamped — the inbound prompt-injection direction, which
  §Risks previously covered only outbound.
- **`close_session` had no foreign-session guard** while `run_*` did, so an
  agent could close a developer's live browser using an id `list_sessions`
  had just handed it.

Correctness:

- **`validated()` did not degrade.** On a schema mismatch it returned the same
  invalid object, which the SDK rejected again — producing exactly the
  `isError`-without-`structuredContent` shape the locked decision forbids, and
  losing `sessionId`/`reportPath` at the worst moment. It now degrades to a
  re-validated fallback. The spec required this mechanism but no test covered
  it, which is why it shipped; there is one now.
- **Malformed SSE frames threw *after* a successful run.** The reader checked
  only `type`, so a bad payload made the fold throw where a handler cannot
  tell it from a pre-flight failure. Frame shape is now checked at the reader
  and a bad frame becomes a warning.
- **`not-run` was claimed on an undecidable ordering** (the forward-filled
  anchor answered "did the run get past step N?" from an earlier row), and the
  frame-ancestry walk **mis-attributed steps when a `frame:push` was dropped**.
  Both now decline to guess.
- **The report poll ran inside the session mutex**, holding the lock for up to
  12 s after a run ended and charging the next caller for it in `queuedForMs`.
  It now runs after the lock is released and honours the caller's signal.
- Progress messages carry the step text rather than `step N`; a `done:aborted`
  we did not request now warns; the global console redirect moved ahead of the
  SDK import, closing the window where a dependency's import-time `console.log`
  could corrupt the JSON-RPC channel.

Known and accepted, tracked in `issues/` rather than fixed:

- **[038](../issues/038-server-identity-is-a-public-constant.md)** —
  identification is by a public constant, so any local process answering
  `/health` with `{"service":"steptix"}` takes arm 1 and receives the
  key and the composed `.env`. The check catches collisions, not attackers.
- **[039](../issues/039-toctou-between-confinement-check-and-read.md)** —
  every §4a rule is check-then-read-by-path, so a symlink swapped into the
  window is followed. The rules are individually sound; the shape they share
  is not.
- **[040](../issues/040-auto-start-log-is-world-readable-on-windows.md)** —
  the auto-start log holds post-interpolation step text, and its `0o600` mode
  is inert on win32.

### W1 — entry, hygiene, deps, shared modules

`src/index.ts`, `src/utils/logger.ts` (`setLogStream` over the 14
stdout sites), `src/mcp/server.ts`, `src/mcp/usage.ts`,
`src/mcp/errors.ts`, `src/mcp/registry.ts`, `package.json` + lockfile,
`src/server/health.ts` (optional `AbortSignal` **only**),
`src/cli/index.ts` (description-only `mcp` stub), tests. No
`src/cli/commands/mcp.ts`.

### W2 — project resolution + assembly

`src/mcp/project.ts` (§4a rules 1–6, `project_root` selection, bounded
config discovery, env compose incl. the `process.env` discovery
fallback), `src/mcp/assemble.ts` (§3's 13-step order, projection,
interpolation), fixtures, tests. Parity reference: `run-controller.ts`
(~1840–1918) and `buildSectionsPayload`; `api-server.ts`'s allow-list
(~187–426) is the authority on what is accepted.

### W3 — client, fold, tools

`src/mcp/api-client.ts` (fetch + SSE reader per §6, returning
`dropped[]`), `src/mcp/run-fold.ts`, `src/mcp/tools.ts`,
`src/mcp/schemas.ts` (every nullable field explicit), tests.

### W4 — auto-start

`src/mcp/server-start.ts`, `.gitignore`, tests. The spawn recipe's
details — host normalization, `shell:false`, the `'error'` listener,
the dist-path resolution — are the point of this workstream.

### W5 — seam tests

Real `createApiServer` on an ephemeral port with deep modules mocked,
driven through a real MCP client over `InMemoryTransport` (verified to
coexist cleanly).

### W6 — docs + ship

`.mcp.json`, `.vscode/mcp.json`, README host setup (4 hosts,
`STEPTIX_MCP_ROOTS` required for the two global ones, four caveats). Root
`npm run build`; assert no `steptix-*`/`runner-core` changes.

## Code review

1. Verify each workstream with `git diff` — ground truth.
2. Run `simplify` before review.
3. Reviewer agent on W2+W3 (assembly parity and folding are where
   silent field-drops live — the `envName` lesson), with §3's table and
   §2's folding rules as the checklist.
4. `security-review` before merge — §4a's six rules, the spawn, arm 2's
   refusal, key handling (never log `STEPTIX_SERVER_API_KEY` or the composed
   `env`, including to stderr), and the result payload as egress.

## Repo gotchas (from project memory — real, previously hit)

- The running server executes `dist/` — server-side changes are not live
  until `npm run build` + restart. Hosts also run the MCP server from
  `dist/`: rebuild before every live smoke.
- Root `npm test` occasionally fails ALL files at once (transient
  worker-pool crash, ~8 s, 0 tests). Re-run before believing it.
- Test at the client seam — through the real api-server app.
- Framework/server changes need **no** extension version bump.
