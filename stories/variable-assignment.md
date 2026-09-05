# Setting a variable from other variables, without a model in the loop

## In plain terms

A test's variables only ever come from somewhere *outside* the test: a value
read off the page, a count, a tool's return, a `## Parameters` bullet, an
environment file. There is no way to say *"make `{{reference}}` equal to
this"* — not a copy of one variable into another, and not a string built out
of one.

Try it today and the step reaches the model as prose. `Store the account
number as {{reference}}` turns into `Store 1234 5678 as {{reference}}` — the
source is interpolated, the target is left literal with an "Unresolved
placeholder" warning — and the model, whose only writers are `read` and
`count` against the DOM, either fails the step or emits a `noop`. Either way
`{{reference}}` is still unset when a later step trips over it. The two
things that *can* do it, a code-behind entry or a two-line tool, are
escape hatches that happen to cover it, not a way of saying it.

This story adds one step form:

```markdown
7. Set {{reference}} to "Ref: {{account_number}}"
```

The right-hand side is a quoted string. Every `{{name}}` inside it is replaced
from the test's variables as they stand at that step, and the result is stored
under the target name. No model, no page, no cache — it costs what a string
replace costs.

### What it looks like in practice

**You write:** `Set {{reference}} to "Ref: {{account_number}}"`, after a step
that read the account number.
**You get:** `{{reference}}` = `Ref: 1234 5678`, in a millisecond, with the
browser untouched and the token count unchanged.

**You write:** `Set {{backup}} to "{{transactions}}"`
**You get:** a copy. Quoting the whole template is how you say "just this
variable"; there is no bare-name form.

**You write:** `Set {{note}} to "Balance on ${data.run_date}: {{balance}}"`
**You get:** both references resolved in the one pass every ordinary step
now uses — `${data.run_date}` and `{{balance}}` alike — the way
placeholder-preserving-actions already resolves them for the model's own
actions (see §"What was measured" below on that story and where it lives).

**You write:** `Set {{reference}} to "Ref: {{acount_number}}"` — a typo.
**You get:** a failed step naming `{{acount_number}}` as the placeholder
nothing has set. Nothing is stored. An ordinary step would have passed the
six literal characters through to the model with a warning; this one has no
model to hand them to, and a variable holding `{{acount_number}}` would sail
through every later step green.

**You write:** `Set {{reference}} to Ref: {{account_number}}` — no quotes.
**You get:** a parse error pointing at the line, before any browser opens.
`Set {{name}} to` is a claim on the line, the way `[skill:` is; a claim
that does not parse is an error, not prose.

Against the fixture app, the whole thing reads:

```markdown
## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Read the available balance [as: balance]
7. Set {{summary}} to "{{username}} had {{balance}} available"
8. Assert that "{{summary}}" contains "{{balance}}"
```

Step 7 runs as code. Steps 6 and 8 are ordinary AI steps and do not know the
difference — step 8 sees `Assert that "demo@securebank.com had $1,234.56
available" contains "$1,234.56"`, a predicate with both sides already
substituted, which is exactly what it would have seen had the value come off
the page.

> **Verification rule for this story.** "Done" means: (1) a `Set` step runs
> with **no model call, no page action and no cache file** — the AI client is
> never invoked, the result's `turns` is empty and the run's token total is
> unchanged — proven separately in each of the four step loops: the CLI
> runner (a main-flow step *and* a hook-scope step), the Sessions API, an
> errand, and the Electron runner; (2) the stored value is the quoted text
> with every `{{name}}` replaced from the scope **as it stands at that step**
> — a name assigned twice reads its latest value — and a `${env.X}` /
> `${data.x}` resolved in the same run-time pass, using the same substituter
> ordinary steps use; (3) a `{{name}}`
> in the template that the scope does not hold **fails the step**, naming the
> placeholder, and stores nothing; (4) recognition is on the authored text,
> *before* `{{}}` interpolation: running the same `Set` a second time (a
> looped section, a re-run from the Variables panel) with the target already
> holding a value still assigns, rather than reading the target as a source;
> (5) inside a skill body the target follows the skill's scoping — an
> undeclared name stays internal (`__skill<N>_…`), a declared `## Outputs`
> name reaches the caller under its `out.x="alias"` — and the server's
> partial-re-run guard does not refuse on the target; (6) the value is
> visible everywhere a capture is: the CLI step line, the report's
> ◆ Captured box, the `capture` stream event with `source: "assignment"`,
> `session.outputs`, the errand receipt's `captures`, and the TestBench
> Variables panel with a label that says it was *assigned* rather than read
> from the page; (7) a value assembled from a secret-named variable, or
> assigned to a secret-named target, is masked by value in every output
> [secret-redaction](secret-redaction.md) covers; (8) compile treats it as it
> treats `[tool:]` — ineligible, "dispatched, not compiled" — never an
> `ai: true` write-off, never a healed step, and a hand-written `.steps.ts`
> entry for that text is never consulted; (9) TestBench completes `{{x}}`
> after a `Set {{x}}` line, F12 on a later `{{x}}` lands on that line, and
> the MCP `run_test_file` / `run_steps` pre-flight does not warn that the
> target "has no value and will reach the AI literally"; (10) an opening
> `Set {{name}} to` with no double-quoted remainder, or with anything but
> whitespace after the closing quote, is a parse error naming the line —
> before a browser is launched — in the CLI, the server and the MCP assembler
> alike; (11) a `Set` whose target is a declared parameter of the enclosing
> skill, or a column of the enclosing looped section's table, is refused at
> parse time with a message that names the target and says why — while a
> `Set` to a run-level row column (a table directly under `## Steps`)
> assigns normally, overwriting that row's seeded value for the rest of the
> instance.

## What was measured, so nobody re-derives it

Everything below is read out of the current tree.

- **There is no writer to reuse.** The action union is `click`, `type`,
  `read`, `count`, `find`, … with no `set` (`src/ai/types.ts`), and
  `extract_value`, despite its name, is a documented no-op that records a
  sub-action and stores nothing (`src/runner/step-executor.ts`, the
  `extract_value` branch). `[store as:]` and `[output:]` are not writers
  either — they steer the model toward a `read`/`count` carrying that `as`
  name (`buildEnrichedInstruction`, `src/server/run-helpers.ts`). Every value
  in `resolvedParameters` was put there by `read`/`count`, a tool's
  `step.setVar`, a code-behind entry's `step.setVar`, an `[input:]` answer,
  or parse-time binding.

- **`{{}}` interpolation runs before marker parsing in all four loops.** The
  CLI does `interpolate(rawInstruction, resolvedParameters)` and then matches
  `[input:]` / `[interactive]` / `[output:]` against the *result*
  (`src/runner/test-runner.ts`, the main loop; `runHookScope` does the same
  for hooks). The server interpolates `originalStep` → `interpolated` and
  runs `isSkippableStep` and `parseOutputPrefixes` on `interpolated`
  (`src/server/session-manager.ts`); so does the errand loop
  (`src/server/errand-runner.ts`) and the Electron runner
  (`src/ui/main/runner-adapter.ts`). The existing markers survive this because
  none of them contain braces. A `Set {{reference}} …` would not: on the
  first run `interpolate` leaves `{{reference}}` in place with a warning, and
  on any run where the name already holds a value it **replaces the target
  with the value**. So the form has to be recognised on the authored text.
  That is the single most important fact in this story.

- **`${env.X}` / `${data.x}` are no longer parse-time text on the CLI's
  main flow, and there is now a shared resolver to reuse instead of
  building one.** Phase 1 of "placeholder-preserving actions" landed (PR
  #126/#127) between this story's first draft and this rebase, and it moves
  exactly this ground. Its own story — `stories/placeholder-preserving-actions.md`
  — is spec-only and lives on the separate, unmerged branch
  `claude/placeholder-preserving-actions`, not in this tree; what shipped is
  read here straight from the diff and the code. `applyEnvDataInterpolation`
  (`src/parser/markdown.ts`) now **validates** every `${…}` reference at
  parse time — same fail-fast, same file-and-line error on an unknown one —
  but keeps `parsed.steps` token-intact rather than rewriting it, "so the
  model sees `${data.url}` as written." `test-runner.ts`'s main loop now
  resolves `${…}` per step, immediately before `{{…}}`, exactly as the
  server and errand loops already did — the one asymmetry left is hook
  instructions, which `applyEnvDataInterpolation` still rewrites into
  `parsed.hooks.*` at parse time (hook bodies are never shown to the model
  as authored text, so there is nothing for them to preserve).

  The phase also added `src/runner/placeholder-substitution.ts`, whose
  `substituteText(text, { parameters, envData })` resolves **both**
  `{{name}}` and `${…}` in one pass over one string — a single combined
  regex (`SUBSTITUTE_RE`), so a value that itself contains `{{` is never
  re-scanned — and whose `collectReferences(text)` enumerates every
  reference either syntax makes, by the same grammars. This is a better
  primitive for a `Set` template than chaining `interpolateEnvData` then
  `interpolate` by hand: one call, one grammar, already used by every AI
  action's own act-time substitution, and it sidesteps the very
  re-scan hazard [issue 023](../issues/023-cache-reverse-interpolation-substring-collision.md)
  is about (there, for a different write path — the cache's blind
  `replaceAll`). `substituteText` itself leaves an unresolved reference as
  written rather than failing — its callers already refused the turn by the
  time it runs — so the `Set` branch composes it with its own
  `collectReferences`-based check, and fails the step there instead (§Where
  it runs), rather than reusing `checkTurnReferences`, whose refusal wording
  is scoped to a model's *action* fields.

  **The Electron runner never resolved `${…}` at all**, in this tree or the
  last — `src/ui/main/runner-adapter.ts` calls only `interpolate`, never
  `interpolateEnvData`, and PR #127 didn't touch it. It worked before this
  phase by the accident of `parsed.steps` arriving pre-baked; it does not
  work now, for any step, `Set` or ordinary. Not caused by this story and
  not this story's to fix, but the `Set` branch there must not quietly
  repeat the gap: `parsedTest.envData` is already on hand (it feeds
  `runSecrets` a few lines away), so the branch's `substituteText` call
  passes it, same as the other three loops, even though nothing else in
  that file resolves `${…}` yet.

- **`[input:]` is the precedent, and it is not the vehicle.** It is the one
  existing step that writes a variable with no model: the CLI writes
  `resolvedParameters[variable]` and pushes a synthetic
  `StepResult{ status: 'passed', turns: [] }`. But the server and the errand
  loop **skip** it as "not supported in API mode" (`isSkippableStep`), the
  extension splits a batch on it to prompt (`ClassifiedStep`,
  `runner-core/src/step-lines.ts`), and the MCP assembler warns that it
  "needs a human". A `Set` needs none of that. Same result shape, different
  classification.

- **Skill scoping renames the target for free — by an accident of syntax.**
  `renameVar` (`src/skills/expander.ts`) rewrites `{{X}}` placeholders and
  `[store as: X]` directives; the second needed its own regex because a
  directive is not a placeholder. A `Set` target *is* a `{{X}}`, so
  `applySkillScope` already namespaces it (`{{__skill1_reference}}`) and
  already applies an `out.x="alias"` rename to a declared output. Free, but
  free because of spelling rather than design — the story pins it with a test
  so the next grammar change cannot silently unpin it.

- **Two kinds of value are baked into step text at expansion time, and a
  target with one of their names would be baked over.** `applySkillScope`'s
  third pass is `interpolate(s, call.args)`: a skill *parameter* is not a
  variable at run time — its value is written into the body text when the
  call expands (the `varScope` comment says so: "their values are
  interpolated into the text, never stored under a name"). Since PR #124, a
  looped section's body gets the same treatment with its row:
  `interpolateQuiet(s, rowBindings)` (`src/skills/expander.ts`), applied
  before the body recurses so a `[skill: x arg="{{col}}"]` line inside it
  reaches the call parser with the value in place
  ([data-driven-rows](data-driven-rows.md), "interpolated into the body text
  at expansion time"). A `Set {{col}} to "…"` in such a body would arrive at
  the runner as `Set 42 to "…"` — a parse error whose message names a number
  nobody typed. Run-level rows are different: a table directly under
  `## Steps` reaches the run through `resolveParameters(test.parameters,
  row)` (`src/runner/test-runner.ts`), so a run-row column *is* a runtime
  variable, seeded per instance, and assignable like any other.

- **The server's partial-re-run guard would refuse a skill-internal target.**
  `if (isPartialRerun && /\{\{__skill\w*\}\}/.test(interpolated))` runs
  before the step-kind dispatch (`src/server/session-manager.ts`). For a
  `Set {{__skill1_reference}} to "…"` the target is *supposed* to be
  unresolved — the step is its writer — so the guard would see a leftover
  and refuse a legitimate re-run. Recognition must precede the guard, and the
  guard must look at the template, not the target.

- **The MCP pre-flight warns on every `{{name}}` it cannot find in
  `parameters`.** `missingParameters` (`src/mcp/assemble.ts`, used by both
  `run_test_file` and `run_steps`) scans every step for `{{(\w+)}}` and
  reports any name absent from the parameter map as one that "will reach the
  AI literally". A `Set` target would be reported. Read, not proven by a
  test: the same scan appears to have no exclusion for `[store as:]` /
  `[as:]` captures either — see §Open questions.

- **TestBench has two scanners of its own, and one contract.**
  `CAPTURE_PATTERNS` in
  `testbench-native/src/extension/env-data-completion-core.ts` is the list
  of "things that write a variable" — `[input:]`, `[output:]`,
  `[store as:]`/`[as:]`, `out.x="alias"` — and it feeds *both* `{{}}`
  completion and F12 (`env-data-definition.ts` calls `captureNamesBefore`).
  `variables-panel.js` in the webview has its own `INPUT_PATTERN` /
  `OUTPUT_PATTERN` / `SKILL_OUT_ALIAS_RE` walk of the `## Steps` span to
  seed rows before a run. Two mirrors of the runtime grammar, in the family
  [issue 035](../issues/035-step-line-span-parser-duplicated-six-times.md)
  documents. The wire contract is `CaptureEvent` in
  `runner-core/src/protocol.ts`: `source: 'capture' | 'toolOutput'`, a
  closed union whose documented back-compat rule is that a consumer must
  treat an absent or unrecognised value as `'capture'`.

- **Compile already has the two doors this needs.** `refuseReason`
  (`src/codebehind/generate.ts`) refuses bracket-token steps and the `prompt`
  action; `compile.ts` marks a `[tool:]` step `ineligible: 'a [tool:] step is
  dispatched, not compiled'` before the model is ever asked. A `Set` step is
  the second kind: it never reaches `executeStep`, so it never has a
  recording to compile from, and it is already code.

- **The report's capture box is keyed on `outputs`.** `renderStep`
  (`src/report/generator.ts`) draws ◆ Captured from `step.outputs` — except
  for a tool step, whose values are already in its purple Outputs section.
  `computeStepCaptures` (CLI) and `autoCapturedNames` (server, errand) fill
  `outputs` only from `read`/`count` sub-actions with no error, so a `Set`
  must set `outputs` directly, the way the tool branch sets
  `toolStep.outputs`.

- **Secrets are masked by value, and the set is taken fresh each time.**
  `secretsNow()` recomputes `runSecrets` from `resolvedParameters` at every
  use (`src/utils/secrets.ts`, "which grow during the run"), so a
  secret-named target joins the mask set the moment it is assigned, and a
  template that embeds `{{password}}` is masked wherever the assembled value
  appears, because the password's own value is a substring of it.

- **A `Set` line can never be a section call, nor a near-miss for one.**
  Section names may not contain `{{` (`sectionNameError`,
  `src/parser/section-match.ts`), so no heading can equal it. The editor's
  "Did you mean section …?" warning
  (`testbench-native/src/extension/section-diagnostics-core.ts`) fires on an
  edit distance of 1–2 between the whole step text and a heading; the two
  braces a heading cannot contain already put a `Set` line further away than
  that, before the quotes are counted.

- **The action cache is not touched by a step that never runs `executeStep`,
  but its neighbours are.** A cached plan for the *next* AI step
  reverse-interpolates every parameter value into `{{name}}` tokens
  (`src/cache/step-cache.ts`), and
  [issue 023](../issues/023-cache-reverse-interpolation-substring-collision.md)
  is that a short value collides with unrelated text. A `Set` that produces
  `"1"` or `"Ref"` widens that surface. Not this story's bug; named so a
  collision after adding a `Set` is recognised for what it is.

- **String transforms already live in tools, on purpose.**
  `fixtures/tools/src/regex_extract.ts` slices a captured value with a
  pattern and fails hard on no match; `strings.ts` has `slugify` and
  `upper`. Concatenation is the one operation that is all *reference* and no
  *computation* — which is why it belongs in the step language and the
  others do not.

- **No step of this shape exists today.** A search of `templates/`,
  `fixtures/` and `tests/` for a step opening `Set {{` finds nothing, so
  claiming the opening changes the meaning of no existing file.

## The step

```
SetStep  := 'Set' WS '{{' Name '}}' WS 'to' WS '"' Template '"' WS?
Name     := \w+
Template := everything from the first '"' after 'to' to the LAST '"' on the line
```

- `Set` is case-insensitive: `set`, `Set`, `SET`.
- `Name` is the same `\w+` every other variable form accepts, so the target
  is always something a later `{{…}}` can spell.
- `Template` is read to the *last* quote on the line, so a `"` inside it is
  literal — `Set {{q}} to "say "hi""` stores `say "hi"` — and there is no
  escape syntax to learn. It may be empty: `Set {{x}} to ""` clears a
  variable to the empty string.
- Inside the template, `{{name}}` is replaced from the scope at execution and
  `${…}` is already text. Nothing else is interpreted: `"{{n}} + 1"` stores
  those characters.
- Nothing may follow the closing quote but whitespace. `Set {{x}} to "a"
  [store as: y]` is a parse error, not a step with two writers.
- A `[no-hooks]` prefix is stripped by the parser before any of this and is
  therefore allowed, though a step that touches no page has no hooks worth
  skipping.

One parser, `parseSetStep(raw)` in `src/parser/set-step.ts`, returns
`{ name, template }` or `null`, and a separate `setStepError(raw)` returns
the parse error for a line that claims the form and does not complete it.
Every runtime that classifies steps calls the first; every parse-time
validator (the markdown parser, the MCP assembler) calls the second so the
error surfaces before a browser exists.

### Where it runs

Each of the four step loops gains one branch, placed **before** its
`interpolate` call and matched against the authored text — the CLI's
`rawInstruction` (and `raw` in `runHookScope`), the server's `originalStep`,
the errand's `originalStep`, the Electron runner's `rawInstruction`. The
branch:

1. checks the template with `collectReferences(template)`
   (`src/runner/placeholder-substitution.ts`): every `{{name}}` not in
   `scope` and every `${…}` `resolveEnvDataRef` cannot answer fails the
   step, naming the reference, in the same wording
   `checkOneString`'s refusals use ("is not a parameter or captured
   variable of this run") so the two failure modes read as one family;
2. resolves the template with `substituteText(template, { parameters: scope,
   envData })` — one call, one pass, both syntaxes, on every loop including
   the Electron runner's (§"What was measured" — its `envData` is already on
   hand, just never threaded before) — and writes `scope[name] = value`;
3. pushes `StepResult{ status: 'passed', turns: [], outputs: { [name]: value },
   aiExplanation: 'Set <name> = "<value>"' }` — the `[input:]` shape with the
   value filled in;
4. on the server and errand paths, records `session.outputs[name]` /
   `captures[name]` and emits
   `{ type: 'capture', line, name, value, source: 'assignment' }`.

The CLI's step log line prints the assignment resolved and masked —
`[set] reference = "Ref: 1234 5678"` — rather than the authored template,
because the authored line is what the report row already shows and the
resolved value is the thing a reader wants to check.

On the server the branch sits above the partial-re-run guard, and the guard
tests the *resolved template* for a leftover `{{__skill…}}` instead of the
whole interpolated line. For any other step the two are the same string.

### What the scanners learn

- **`CAPTURE_PATTERNS`** gains
  `{ re: /^set\s+\{\{(\w+)\}\}\s+to\s+"/gi, marker: 'set' }`. Anchored,
  like the `[input:]` / `[output:]` entries, because the runtime anchors.
  Completion and F12 both come from this one list, so both are covered by
  the one entry.
- **`variables-panel.js`** gains the same anchored regex in its `## Steps`
  walk, seeding a row with `source: "set"` before a run and picking up the
  live value from the `capture` event after. `classifyCaptureSource` learns
  `"assignment"`; anything else still collapses to `"capture"`.
- **`CaptureEvent.source`** (`runner-core/src/protocol.ts`) becomes
  `'capture' | 'toolOutput' | 'assignment'`. Old clients collapse it to
  `'capture'` by the rule already written on the type.
- **`missingParameters`** subtracts every `Set` target found in the same step
  list before it warns — a written name is not a missing one.
- **`compile.ts`** reports `ineligible: 'a Set step is dispatched, not
  compiled'` when `parseSetStep(text)` matches, beside the `[tool:]` case.
- **Parity.** The runtime regex and the two TestBench mirrors are pinned by
  one fixture table of authored lines → `{ name, template } | null | error`,
  consumed by the root vitest, the webview test and the extension test, the
  way the sections work pinned its classifiers. A mirror that drifts fails a
  test rather than an author.

## Locked decisions

- **The right-hand side is always a quoted string.** `Set {{b}} to "{{a}}"`
  is the copy; there is no `Set {{b}} to {{a}}`. One shape means one regex in
  the runtime and two honest mirrors in the editor, and it draws the line
  where the line belongs: an unquoted remainder — `Set {{amount}} to the
  maximum allowed` — is prose about the page, and prose is the model's.

- **Recognised on the authored line, before interpolation.** Not a
  preference: `interpolate` would rewrite the target on every execution
  after the first and warn on the first. The `[input:]` precedent gets away
  with post-interpolation matching only because its marker has no braces.

- **`Set {{name}} to` is a claim, and a claim that does not parse is an
  error.** The README's rule for `[skill:` is that the strict spelling is
  unambiguous intent and therefore a parse error when malformed, while the
  loose spelling falls back to prose. A step opening with a braced target and
  the word `to` has no loose reading — `{{…}}` holds *values*, and "Set
  <value> to …" is not how anyone names a field. The one imaginable
  collision, a parameter used as a field *label* (`Set {{field}} to "12"`),
  reads oddly today and occurs nowhere in the repo. Claiming the opening
  costs that phrasing; leaving it prose would cost a model turn and a
  silently unset variable every time someone forgot a quote.

- **An unresolved `{{name}}` in the template fails the step.** Ordinary steps
  pass an unresolved placeholder to the model with a warning, on the theory
  that the model may still make sense of the sentence. Here there is no
  model, and the alternative — storing the literal `{{acount_number}}` — is a
  green step that poisons every later one. The failure names the placeholder
  and the line. This is also the honest reading of "as the scope stands":
  a name not yet written is not a value.

- **Text only.** No arithmetic, no functions, no slicing, no conditionals.
  `"{{n}} + 1"` stores five characters. Anything that *computes* is a tool,
  where `regex_extract` and `strings.ts` already live, and a tool's
  `out.x="name"` puts the result back in scope. The step language gets the
  one operation that is pure reference.

- **`source: 'assignment'` on the capture event.** The Variables panel exists
  to say where a value came from; labelling an assignment "extracted from the
  page" would mislead precisely the reader that label is for. The union is
  closed, but its own comment mandates the collapse-to-`'capture'` default,
  so a not-yet-upgraded client shows the value with the old label and
  nothing breaks. The cost is a runner-core change and therefore a
  `testbench-native` patch bump; the webview change would have forced the
  bump anyway.

- **Not a new step *class* on the wire.** `ClassifiedStep` in runner-core
  stays `step | input | interactive`. The extension has no reason to split a
  batch on a `Set`, and nothing to prompt for; it is a `step` that the server
  happens to answer in a millisecond.

- **Compile: dispatched, not compiled.** No entry is generated, none is
  consulted, the step is never written off as `ai: true`, and it never
  counts as healed. It is already code. `compile.ts` says so in the same
  words it uses for `[tool:]`.

- **No cache involvement, and issue 023 is named rather than fixed.** A
  `Set` neither reads nor writes `.cache/`. Its value does enter the
  reverse-interpolation of neighbouring cached plans, like every other
  variable; a short assigned value is one more way to hit a known open
  issue, not a new one.

- **Skill scoping is inherited, and pinned.** The target is a `{{X}}`, so
  `renameVar` already namespaces internals and aliases declared outputs.
  The story adds the test that proves both — a `Set` to an internal name
  inside a skill does not leak, a `Set` to a declared output reaches the
  caller under its alias — because the behaviour is currently free by
  spelling, and a later grammar change that stops treating the target as a
  placeholder would take it away without failing anything.

- **A target that expansion would bake over is refused at parse time, by
  name.** Inside a skill body, `Set {{p}} to "…"` where `p` is a declared
  `## Parameters` name; inside a looped section body, `Set {{col}} to "…"`
  where `col` is one of that table's columns. Both are refused when the
  *authored* body is validated — before expansion, so the message can say
  what actually happened: *"`{{username}}` is a parameter of this skill, and
  parameters are values written into the step text, not variables — assign
  to an output or an internal name instead"*, and the row equivalent. Left
  to run, the target would already be a literal by the time the runner
  looked, and the author would be reading a parse error about `Set
  demo@securebank.com to …`. Refusing by name at the layer that still knows
  the name is the same choice the sections work made for `[`-leading
  headings. Run-row columns are deliberately *not* refused: they are runtime
  variables, and overwriting one in a later step is an ordinary thing to want.

- **Errands get it too, and the receipt is the only scope.** The value lands
  in `captures` like a `store as` would; a later errand starts empty, exactly
  as the tool description already says.

- **The Electron runner is a real fourth copy.** `src/ui` was touched this
  week; it is not a stated exception. It gains the branch or the story is
  three-quarters done.

## What already exists vs what is new

Reused unchanged: `collectReferences` / `substituteText` / `PlaceholderValues`
(`src/runner/placeholder-substitution.ts`); `resolvedParameters` / the
errand's `scope`; `StepResult.outputs` and the ◆ Captured rendering; the
`capture` event and `session.outputs` / `outputSources`; `secretsNow` and
`redact`; `renameVar` and `applySkillScope`; `captureNamesBefore` and
everything downstream of `CAPTURE_PATTERNS`; the compile `ineligible`
listing; the `[input:]` synthetic-result shape.

Changed, once each: `CaptureEvent.source` and `classifyCaptureSource`
(union + one value); `CAPTURE_PATTERNS` and the `variables-panel.js` steps
walk (one entry each); `missingParameters` (subtract targets); the server's
partial-re-run guard (test the template, after the branch); `compile.ts`
(one ineligible reason); README "Special step prefixes" gains a short
"Variables" paragraph, SPEC.md gains a `#### Set {{name}} to "…"` block
beside `[input:]`, SPEC-SESSIONS-API.md's Step Format gains a bullet; the
`run_steps` / `run_errand` descriptions say "`store as` and `Set` values"
where they say "`store as` captures".

New: `src/parser/set-step.ts` with `parseSetStep` / `setStepError`; the branch
in four loops; a parse-time validation call in the markdown parser and the
MCP assembler; the fixture table and its three parity tests; per-loop tests
modelled on `tests/cli-viewport.test.ts` (CLI), the `capture events stream
with source="capture"` case in `tests/api-server.test.ts` (server), the
errand suite, and the runner-adapter suite; a runner-core `node --test` case
for the widened union; a fixture test file exercising the securebank example
above, run live through the CLI and through TestBench against the fixture app
with the token counter at zero for the `Set` step.

`testbench-native/package.json` patch bump (runner-core and webview both
change).

## Not in this story

- **Expressions.** No `+`, no `upper()`, no `[0:4]`. Tools.
- **A bare-name form.** `Set {{b}} to {{a}}` without quotes is a parse error
  under this grammar and stays one.
- **Conditional assignment**, defaults (`Set {{x}} to "…" if unset`), or
  unsetting a variable.
- **A bracket alias** such as `[set: name] "…"`. One spelling.
- **Consolidating the step-line parsers.** This story adds one runtime regex
  and two editor mirrors and pins them with a parity table; it does not
  attempt [issue 035](../issues/035-step-line-span-parser-duplicated-six-times.md),
  and says plainly that it makes that issue one pattern larger.
- **Retitling the report box.** See below.

## Open questions

- **Should the report's ◆ Captured box say "Assigned" for a `Set` step?**
  Cosmetic, and best decided by looking at the rendered page rather than at
  a description of it — the box title is the only place the report would
  still call an assignment a capture once the panel and the event no longer
  do.

- **Does `missingParameters` already misreport captured names?** Read, not
  proven: the scan has no exclusion for `[store as:]` / `[as:]` writers, so a
  `{{balance}}` used after `Read the balance [as: balance]` looks as though it
  would be warned as "no value" on every MCP run of that file. If a test
  confirms it, teaching the scanner about `Set` targets and about captures is
  the same edit to the same list, and belongs in the same PR.
