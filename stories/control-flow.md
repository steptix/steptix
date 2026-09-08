# Control flow: if, else and loops on numbered lines, with sections as bodies

**Built 2026-09-09.** The grammar, the expander, the planner, all three run
loops, the judge, the report, TestBench and the Electron runner, with the docs
and a live-proven fixture. §"What the build showed" at the end records where
the build departed from this spec and what the first live run found.

## In plain terms

A test can already *reuse* a block of steps (a `### Section`), *repeat* one
over authored data (a table under the section), and *watch* for one of several
page states (`If a Remember this device prompt appears, click Not now`). What
it cannot do is **decide**: look at the page or at a variable, and run one
block of steps or another because of what it saw. Nor can it repeat a block
*until* the page says stop, or once per item it found on the page rather than
once per row the author typed.

Try it today and the decision reaches the model as prose. The handbook says so
in as many words: a section, skill or tool named inside an `If` clause is not
conditional dispatch, and "for real branching logic, write a tool". A tool can
branch, but its branches are code, not steps — nothing paints, nothing can be
stepped into, and the natural-language test stops being the test.

This story adds six step forms. Every one is a single numbered line; every
one names, as its last part, **one step to run** — most usefully a `### Section`,
which is already this format's multi-line block:

```markdown
5. If the Cash checkbox is ticked, then Pay with cash
6. Otherwise, Pay by card
7. Verify the order confirmation is shown

### Pay with cash
1. Click Pay now
2. Verify the receipt says Paid in cash

### Pay by card
1. Enter the card details
2. Click Pay now
```

```markdown
6. While the Next button is enabled, Go to the next page
7. Repeat Load more results until the Load more button is gone, up to 20 times
8. For each {{account}} in {{accounts}}, Check the account balance
```

The control line is the step the framework handles. Its **condition** is a
sentence the model answers yes or no to, written the way a `Verify` step is
written. Its **tail** is one step of any kind — a section name, a
`[skill: …]`, a `[tool: …]`, a `Set {{x}} to "…"`, or a plain page
instruction — and it runs, or does not, or runs again, according to the
answer. Nothing is indented, nothing nests inside a list item, and a body of
more than one step is a section, as it already is for reuse.

### What it looks like in practice

**You write:** `If the Cash checkbox is ticked, then Pay with cash` and, on
the next line, `Otherwise, Pay by card`.
**You get:** the page settles, the model is asked once whether the Cash
checkbox is ticked, and exactly one of the two sections runs. In TestBench the
taken line and its section paint ✓; the other line and its section paint as
skipped, so you can read which way it went off the editor. The report shows
the same: the guard row carries the model's reasoning, the untaken section's
rows are skipped.

**You write:** `If {{plan}} is "pro", then [skill: enable_pro_features]`.
**You get:** the skill runs only when the variable says so. Today that line
is prose, and the model — which cannot dispatch a skill — either performs
some approximation of it or does nothing.

**You write:** `While the Next button is enabled, Go to the next page`.
**You get:** the condition is checked, the section runs, the condition is
checked again, until it is false or the cap is reached. Each pass paints the
section's lines again and gets its own band in the report, labelled `Go to the
next page (3/?)` while it runs and `(3/7)` once the loop has ended. Reaching
the cap with the condition still true **fails** the `While` line, the way a
wait that never resolves fails.

**You write:** `Capture the names of every account in the list [store as:
accounts]`, then `For each {{account}} in {{accounts}}, Check the account`.
**You get:** the section runs once per captured name, with `{{account}}` bound
to that name for the pass — the same shape as a table under the section, fed
from the page instead of from the author.

**You write:** `If a Remember this device prompt appears, click Not now`
(no `then`).
**You get:** exactly what you get today. The watch form is untouched; `then`
is what opts a line into the new behaviour.

### More examples

A three-way chain, a nested decision, and a loop whose body is a single
instruction rather than a section:

```markdown
## Steps
1. Sign in
2. Open the Payments page
3. If the Cash checkbox is ticked, then Pay with cash
4. Else if the Card checkbox is ticked, then Pay by card
5. Otherwise, Verify the Pay now button is disabled
6. Repeat Click Load more until the Load more button is gone
7. Sign out

### Pay by card
1. Enter the card details
2. If a 3-D Secure frame appears, then Complete the bank challenge
3. Click Pay now

### Complete the bank challenge
1. Type "{{otp}}" into the One-time code field in the bank frame
2. Click Confirm in the bank frame
```

Step 5's tail is a plain instruction, which is fine for a one-step branch.
Step 6 loops a plain instruction too. Step 2 of `Pay by card` shows a decision
inside a branch body, with the inner body in its own section — that is the
only way to nest, and it is the same way sections have always nested.

## Context — what exists, and what is missing

Four things in the codebase shape this more than anything new.

**`If …` steps are already a construct**, and a good one for what it does.
[stories/conditional-step-lookahead.md](conditional-step-lookahead.md) shipped
`identifyStepGroups` ([src/runner/step-grouper.ts](../src/runner/step-grouper.ts)):
a run of consecutive `If …` / `When prompted …` / `When asked …` lines plus the
next ordinary step form one group; `executeBranchedStep` waits for the page to
settle, asks the model which outcome the page shows, re-asks every three
seconds while it says "waiting", performs the matched line's actions, and marks
the rest `skipped`. It exists because a page can take thirty seconds to decide
whether to show an MFA prompt, and a single snapshot commits too early. Its
semantics are those of a **watch**: it waits for one of several states to
*appear*. Handbook §3.4 documents it, and then draws the line this story
moves: `[tool:]`, `[skill:]` and section names inside an `If` are not
conditional dispatch.

Two properties of that group matter here. Consecutive `If` lines are **one
group in which exactly one runs** — two independent conditions in a row are
already alternatives today, which is either the else-if the author wanted or a
surprise. And a `Set` step cannot be a continuation: the grouper then forms
no group at all and the conditionals run as ordinary steps. The new control
lines need the same exclusion, or an `If …, then …` following a watch `If`
becomes its continuation and the watch swallows it.

**Sections and skills expand at parse time into one flat step list.** The
runner sees `steps[]` with parallel `origins[]` (input index, frame id) and a
`frames{}` table ([src/skills/expander.ts](../src/skills/expander.ts)). Every
downstream consumer assumes that list is fixed before the run starts: line
anchors for pause and resume (`startAt` / `endAt`), breakpoints, TestBench
painting, the report, code-behind occurrence indexing (`spliceEntry` places
an entry at `spans[occurrence]`), the cache-bundle hash over `fullSteps`.
A section called once expands once; a section with a table expands once per
row, each pass in its own frame with `iteration` and `iterationCount`
([stories/data-driven-rows.md](data-driven-rows.md), part B), and every
consumer already copes with the same source line running several times.

**Indented numbered items are not steps anywhere.** The runner-core
classifier ([runner-core/src/step-lines.ts](../runner-core/src/step-lines.ts))
ignores them by design, and the CLI's marked-based parser folds a nested list
into the parent item's text (`classifyReading` in
[src/parser/markdown.ts](../src/parser/markdown.ts)). A block with indented
sub-steps would today reach the model as one long prose step. Making nesting
real would mean a new line kind in every one of the six step-line parsers
[issue 035](../issues/035-step-line-span-parser-duplicated-six-times.md)
counts, plus painting, breakpoints, renumbering and go-to-definition for nested
lines. The sections story weighed block syntaxes and chose `###` for the same
reasons ([stories/test-script-sections.md](test-script-sections.md), "Why
bare-name + `###`").

**The house grammar has a rule for claims.** `[skill:` and `Set {{x}} to` are
*claims*: unambiguous intent, so a malformed one is a parse error naming the
line rather than prose handed to a model. Loose spellings fall back to prose.
`Set` also fixed two conventions this story inherits: a framework-handled
step is recognised on the **authored** line, before interpolation, and it is
**not a new step class on the wire** — the server does the work
([stories/variable-assignment.md](variable-assignment.md), "Locked decisions").

## Syntax

### The six lines

Keywords are case-insensitive and must open the instruction (after the `N. `
ordinal and an optional `[no-hooks]` marker, which is stripped first exactly
as `parseSetStep` strips it).

```
IfLine       := 'If' WS Condition ','? WS 'then' WS Tail
ElseIfLine   := ('Else' | 'Otherwise') WS 'if' WS Condition ','? WS 'then' WS Tail
ElseLine     := ('Else' | 'Otherwise') ','? WS Tail
WhileLine    := 'While' WS Condition ',' WS Tail Cap?
RepeatLine   := 'Repeat' WS Tail WS 'until' WS Condition Cap?
ForEachLine  := 'For each' WS '{{' Ident '}}' WS 'in' WS '{{' Ident '}}' ',' WS Tail
Cap          := ',' WS? 'up to' WS Integer WS 'times'      // Integer ≥ 1
Condition    := free text, no leading/trailing whitespace
Tail         := one step (see "The tail")
Ident        := [A-Za-z_]\w*
```

Where the split falls, in one line each, because these are the rules an
author trips over:

- `If` / `Else if`: the **first** ` then ` (with or without a comma before it)
  ends the condition. A condition containing the word "then" must be
  reworded.
- `While`: the **first** comma ends the condition. A condition with a comma
  in it must be reworded; the tail may contain commas.
- `Repeat`: the **first** ` until ` ends the tail. A tail containing the word
  "until" must go in a section.
- `For each`: fixed shape; the comma after the second `}}` is the split.
- `Cap`: matched at the **end** of a `While` or `Repeat` line and removed
  before the rest is parsed. `For each` takes no cap — the list is its bound.

### What claims, and what stays prose

A line **claims** a form when it matches the opening below. A claimed line
that does not complete the grammar is a **parse error** naming the line and
what is missing — the `Set` rule. A line that does not claim is prose and
reaches the model as today.

| Opening | Claims | Why this and not less |
| --- | --- | --- |
| `If …` with a later ` then ` | `IfLine` | `If <cond>, <action>` without `then` is the existing watch form and must keep meaning that. `then` is the opt-in. |
| `Else` / `Otherwise` at line start | `ElseIfLine` or `ElseLine` | Neither word opens a page instruction. Both spellings are accepted; `Else if` reads far better than `Otherwise if`, and `Otherwise, Pay by card` reads far better than `Else, Pay by card`. |
| `While …` | `WhileLine` | A new keyword with its programming meaning. A prose opener like "While on the dashboard, click Settings" becomes a loop that fails loudly at the cap — never a silent misread. |
| `Repeat …` with a later ` until ` | `RepeatLine` | `Repeat the search` is a plausible prose step; ` until ` is what makes it a loop. |
| `For each {{` | `ForEachLine` | The braces claim. `For each product in the list, verify its price` (no braces) is prose and stays prose. |

Two things that never claim: a step opening with `[skill:`, `[tool:`,
`[input:` or `[interactive]` (their own grammars win), and a step whose match
text equals a section name (a section called `While waiting` is a bad name,
but the bare-name rule resolves first — see decision 3).

### The tail

The tail is **one step**, dispatched by the ordinary step rules in the
ordinary order:

1. A bare section name (matched by the section rule, contract §2) runs that
   section's body.
2. A `[skill: …]` line runs the skill.
3. A `[tool: …]` line runs the tool.
4. A `Set {{x}} to "…"` line assigns.
5. Anything else is a page instruction the model performs.

Refused, at parse time, with a message naming the line: a tail that is itself
a control line (`If a, then If b, then X` — nest through a section); a tail
that is `[input: …]` or `[interactive]`; an empty tail. A tail that is a
section name whose body is empty hits the existing "invoked but has no steps"
error. A tail that *almost* matches a section name falls to rule 5, which is
the accepted bare-name risk with the accepted mitigations: the editor renders
a resolved tail as a link and squiggles a near miss, and a section only ever
named in tails is **live** (§"Liveness").

### The condition

Free text, written like a `Verify` sentence: `the Cash checkbox is ticked`,
`{{plan}} is "pro"`, `the Load more button is gone`, `the cart shows more than
3 items`. It reaches the model **as authored**, placeholders intact, with the
same `## Values` block a step gets (secret-named values masked) — the
placeholder-preserving rule applies to conditions exactly as to steps.

## Semantics

### A chain is a decision

An `If` line opens a **chain**: the `If`, zero or more `Else if` lines, and
at most one `Else`/`Otherwise`, on **consecutive step lines of the same
flow** (the main flow, or one section body; blank lines and prose between
them do not break the chain, another numbered step does). An `Else if` or
`Otherwise` that does not follow a chain member is a parse error. `Otherwise`
must be last.

When the run reaches the `If`:

1. **Settle.** The existing page-stability gate runs (`waitForPageStability`,
   the same 10 s cap and 1 s quiesce the branched step uses).
2. **Ask once.** Every condition in the chain is put to the model in one
   call, in order, with the instruction to name the **first** one that holds
   now, or `none`. The response may also say `waiting` if the page is
   visibly still transitioning; then the framework re-asks every 3 s for up
   to 30 s and, still waiting, **fails the `If` line** with "could not decide:
   the page did not settle". A malformed response counts as a `waiting`.
3. **Dispatch.** The selected member's tail runs, its steps in order, as the
   ordinary steps they are. That member's result is `passed`. Every other
   member of the chain, and every step of every other tail, is `skipped`.
   `none` with an `Otherwise` selects the `Otherwise`; `none` without one
   skips the whole chain and the run continues after it.
4. **Failure inside a tail** fails the run exactly as a failed step does.

A decision is evaluated **once**. A false answer is an answer, not a timeout.
That is the whole difference from the watch form, and the sentence for the
handbook is: *an `If` with `then` is a decision; an `If` without one is a
watch.*

### A loop is a decision made again

- `While <cond>, <tail>` — settle, ask, and if the condition holds run the
  tail and go back to *settle*. Zero or more passes.
- `Repeat <tail> until <cond>` — run the tail, then settle and ask; stop when
  the condition holds. One or more passes.
- `For each {{x}} in {{list}}, <tail>` — `{{list}}` must hold a JSON array
  (what a plural `read` stores, and what an array-typed tool output stores).
  For each element in order, bind `{{x}}` to it (a non-string element is
  bound as its JSON text) and run the tail. No model call decides anything;
  the list is the bound. A value that is not a JSON array **fails the line**:
  *"`{{accounts}}` holds `Savings, Everyday`, not a list — capture it with a
  read of every matching element, or a tool that returns an array."*

`While` and `Repeat` each ask the model once per pass. Both stop at the
**cap**: the line's own `, up to N times` if written, else
`execution.maxLoopIterations` from config (new key; default 25). Reaching the
cap with the exit condition unmet **fails the loop line**: *"the Next button
was still enabled after 25 passes (execution.maxLoopIterations); raise the cap
on the line with `, up to N times` or check the exit condition."* A loop that
exits normally passes; its guard line gets **one result per evaluation**, each
carrying the pass's loop marker, so the cost of the decisions is visible in
the report.

A `While` that never runs its tail: the guard is `passed` (it decided), the
tail's steps are `skipped`. A `For each` over an empty list is the same.

### Painting, frames and the report

**Chains** add nothing to the frame model. The tail is expanded **in place**,
as if it were the step at that position: a section tail becomes a section
frame exactly as a bare-name call does; a plain-instruction tail is one step
in the enclosing frame. What is new is a **control record** on the guard
(§"Design") giving the index range of its body and the end of its chain, so
the runtime knows what to skip and where to resume. The guard line paints ✓
when taken and skipped when not; body lines paint through the section-body
painting that already exists; the report's guard row shows the condition and
the model's reasoning, and the untaken tails' rows show as skipped under their
section badge. Whether a long untaken section should collapse to one row in
the report is a call to make when one is rendered; v1 shows every row, which
is what a matrix does with rows that did not run.

**Loops** reuse the machinery part B of the rows story built. Each pass
clones the tail's frames with a fresh id and stamps `iteration` (1-based) and
`iterationCount`; body-step results carry `loop: { kind: 'iteration',
label, index, count }`, where `label` is the section's name for a section
tail and the tail's own text otherwise. Two things are new:

- `iterationCount` is **unknown while a `While` or `Repeat` runs**. The frame
  and the live marker omit it; TestBench's frame label reads `Name (3/?)`;
  the server back-fills `count` on every marker of that loop when the loop
  ends, so the rendered report reads `(3/7)`. `For each` knows its count from
  the start and reads `(3/7)` throughout.
- The clone happens **at run time**, not at expansion. The flat list does
  not grow: the runtime jumps back to the guard's index and re-runs the same
  indices under the new frame id. Every consumer that reads a frame id from
  an event already handles ids it has not seen before (that is what a fresh
  expansion is), and every consumer that reads a step index already handles
  the same index twice (that is what a data row is).

A breakpoint on a guard line pauses before the decision. A breakpoint on a
body line fires on every pass when the body is a section. A loop whose tail is
a plain instruction shares the guard's own main-flow line; in TestBench a
breakpoint there is handled by the client's batch split and pauses once per
run, while the Electron Runner UI, which pauses in-process, stops on every
pass. F11 on a guard steps into the tail.

### Runs that start or end mid-structure

The bounded-run rules extend the snapping the branched group already has:

- A run whose `endAt` lands on a guard is **snapped to the end of the
  structure** (a chain's `chainEnd`, a loop's `bodyEnd`), so *Run Step Here*
  on a guard evaluates it **and** runs what it selects. A guard evaluated with
  its body sliced away would be a decision with no consequence.
- A run whose `startAt` lands **inside a tail** treats that tail's guard as
  taken: the body runs from the start line, the chain's other members and
  their tails are skipped. That is what an author who clicked a line inside
  `Pay by card` meant. Inside a loop body, the pass completes and the loop
  continues from the guard as normal; the pass number restarts at 1, because
  the count lived in the batch that was paused. Documented, not hidden.
- An `[input:]` line **between chain members** cannot happen in a file the
  parser accepts: a chain is consecutive step lines and an `[input:]` line is a
  step, so the `Otherwise` after it is refused as dangling. What can happen is
  a client running a file the CLI would refuse — TestBench does not parse with
  `parseTestContent` — and a subset batch that *begins* with a dangling
  `Otherwise` would, left alone, run its tail unconditionally. So the same
  dangling-member rule is enforced three times with one wording: the parser,
  the expander (the wire path's only parser), and runner-core's pre-flight
  under its own TB code. Inside a *tail's section body* an `[input:]` is fine
  — same carve-out sections already have.

### What is deliberately unchanged

- The watch form: `If <cond>, <action>` with no `then`, and the `When
  prompted` / `When asked` spellings, group and poll exactly as today.
- Consecutive watch `If`s remain one exactly-one-runs group. The docs now say
  so, and offer `Else if` as the spelling that means it on purpose.
- A control line is `kind: 'step'` on the wire; runner-core's
  `ClassifiedStep` stays `step | input | interactive`. The server does the
  work.
- A control line is never cached and never compiled. The guard is dispatched,
  like `Set` and `[tool:]`; its tail's steps compile and cache as they would
  anywhere — except that steps **inside a loop body** opt out of the step
  cache the way row runs do (decision 8 of the rows story, same reason: the
  cache rewrites one value per line, and a pass is a different value).

## Design

### Parser — new `src/parser/control-line.ts`

Two entry points, the `set-step.ts` split:

```ts
export type ControlLine =
  | { kind: 'if' | 'elseif'; condition: string; tail: string }
  | { kind: 'else'; tail: string }
  | { kind: 'while'; condition: string; tail: string; cap?: number }
  | { kind: 'repeat'; condition: string; tail: string; cap?: number }
  | { kind: 'foreach'; item: string; list: string; tail: string };

/** Runtime question: is this (authored) instruction a control line, and what
 *  does it say. Strips a leading `[no-hooks]`. Null when the line does not
 *  claim, or claims and does not complete (the validator says why). */
export function parseControlLine(instruction: string): ControlLine | null;

/** Parse-time question: does this line claim a form and fail to complete it?
 *  Returns the message, or null. Runs where `setStepError` runs: `## Steps`
 *  and section bodies of tests and skills, MCP-supplied steps. */
export function controlLineError(instruction: string): string | null;
```

`parseTestContent` / `parseSkillFile` ([src/parser/markdown.ts](../src/parser/markdown.ts))
validate every step line and every section-body line with `controlLineError`,
then validate **chain structure** over each flow (main flow, each section
body) in authored order: `Else if` / `Otherwise` must follow an `If` or `Else
if`; `Otherwise` at most once and last; a tail may not be a control line, an
`[input:]` or `[interactive]`. `[no-hooks]` before a control line is legal and
means what it means on a section call: the whole tail is opted out.

Two refusals borrowed from `Set`. A `For each {{x}}` whose `x` is a declared
skill parameter, or a column of a table the enclosing section loops over, is
refused by name at parse time ("`{{x}}` is a parameter of this skill … loop
over a different name"), because expansion would bake the name over and the
runtime would see `For each demo@x in …`. And the expander's
`checkedRowInterpolate` gains the same guard for merged row bindings.

### Grouper — `isConditionalStep` excludes control lines

`identifyStepGroups` must neither group an `If …, then …` as a watch nor
accept any control line as a **continuation**. The second is the Set
precedent, and the same fix: form no group. Both loops already advance past a
group with `i = group.continuationStep.index`, so a control line swallowed as
a continuation would vanish from the run.

### Expander — control records, in-place tails, liveness

`expandRecursive` recognises a control line (via `parseControlLine` on the
match input, the same text section resolution reads) and emits:

1. the guard itself, as a step, with its origin as usual;
2. the tail, expanded as a **one-element step list** through the same
   recursion — so a section tail resolves against the current sections map, a
   skill tail through `expandSkills`, and a plain tail is emitted as itself —
   in the enclosing frame;
3. a `ControlRecord` for the guard, in a new parallel array
   `controls: (ControlRecord | null)[]` on `SkillExpansion` and on
   `ParsedTest.expansion`:

```ts
export type ControlRecord =
  | {
      kind: 'if' | 'elseif' | 'else';
      chainId: string;           // shared by every member of one chain
      condition?: string;        // absent on 'else'
      bodyStart: number;         // absolute index of the tail's first step
      bodyEnd: number;           // … and its last (inclusive)
      chainEnd: number;          // absolute index of the chain's last step
    }
  | {
      kind: 'while' | 'repeat';
      condition: string;
      bodyStart: number;
      bodyEnd: number;
      cap?: number;              // from `, up to N times`; config otherwise
      label: string;             // section name, or the tail text
    }
  | {
      kind: 'foreach';
      item: string;
      list: string;
      bodyStart: number;
      bodyEnd: number;
      label: string;
    };
```

Indices are absolute in the flat list, and a chain's members are found by
`chainId`. Nesting is by containment: a chain inside a tail's section body has
ranges strictly inside the outer body's range. The server slices bounded runs
by absolute index already, so the records survive `startAt` / `endAt`.

A dangling `Else if` / `Otherwise` — one whose previous step is not a chain
member — is refused here too, with the parser's wording. The wire path never
passes through `parseTestContent`, and an `Otherwise` that opened a chain of
its own would run its tail unconditionally.

**Liveness** (contract §2.4) gains one clause: *a section named as the tail
of a control line is invoked*. Both consumers of the rule — the expander's
dead-section warning and runner-core's `section-index.ts` (`calls`,
`nonCallSteps`, the "never used" diagnostic, go-to-definition, document
links) — learn it, with `nameStart` pointing at the tail's first character so
the link underlines the section name and not the keyword.

### Runtime — `src/runner/control-flow.ts`, a pure planner

Four run loops execute steps — the CLI ([src/runner/test-runner.ts](../src/runner/test-runner.ts)),
the Sessions API ([src/server/session-manager.ts](../src/server/session-manager.ts)),
the Electron UI ([src/ui/main/runner-adapter.ts](../src/ui/main/runner-adapter.ts))
and, through the server, MCP and errands. None of them should grow a second
interpreter. The planner is pure, unit-tested on its own, and answers two
questions:

```ts
export interface ControlPlan {
  /** Steps to mark skipped before continuing, as inclusive index ranges. */
  skip: Array<[number, number]>;
  /** Index to continue from. */
  next: number;
  /** For loops: the pass that is starting, when a body is about to run. */
  pass?: { iteration: number; count?: number; bindings?: Record<string, string> };
}

/** The guard at `index` has been evaluated (or a For each list read). */
export function planAfterGuard(
  controls: readonly (ControlRecord | null)[],
  index: number,
  verdict: { selected: number | null } | { list: string[] } | { holds: boolean },
  state: ControlState,
): ControlPlan;

/** Step `index` just finished. If it closes a loop body, where next? */
export function planAfterStep(
  controls: readonly (ControlRecord | null)[],
  index: number,
  state: ControlState,
): { next: number; reevaluate?: number } | null;

/** A run starting at `startIndex`: which guards count as taken? */
export function planForStart(
  controls: readonly (ControlRecord | null)[],
  startIndex: number,
): ControlPlan;
```

`ControlState` holds per-guard pass counters and the current `For each`
cursor, and the runtime frame aliases for the pass (§"Painting"). A loop
re-entry is `next: guardIndex` with the state advanced; a cap breach is a
verdict the loop turns into a failed guard result.

Each run loop then gains three small hooks: before executing step `i`, if
`controls[i]` is set, evaluate and apply `planAfterGuard` (marking the `skip`
ranges by emitting skipped results, then continuing from `next`); after
executing step `i`, apply `planAfterStep`; at batch start, apply
`planForStart`. The Electron runner is the fourth copy and gains the same
three hooks or the story is three-quarters done.

### Condition evaluation — `evaluateConditions` in `step-executor.ts`

One function, used by chains and loops alike:

```ts
export async function evaluateConditions(
  conditions: string[],         // authored text, placeholders intact
  opts: StepExecutorOptions,
): Promise<{ selected: number | null; reasoning: string; aiInteractions: AiInteraction[] }>;
```

It runs the stability gate, builds a **judge** message — the branched-step
prompt with a `none` outcome and with actions forbidden: *name the first
condition that holds now; do not act* — including the `## Values` block the
step prompt builds, and parses the answer with `parseBranchedResponse`. It
re-asks on `waiting` every 3 s for up to 30 s, then throws a step failure
naming the condition. It never performs an action; the selected tail's steps
do that, through `executeStep`, which is why a plain-instruction tail costs
two model turns where the watch form costs one. The watch form stays the
right tool for "if it appears, dismiss it".

### Reports, frames, config

- `StepResult` gains nothing. Guard rows are ordinary rows with the guard's
  instruction, status and `aiReasoning`; skipped rows already render; loop
  bands already render from `loop`. The generator back-fills `count` per
  loop before rendering (a `chainId`-free key: guard index plus batch).
- `ExpandedFrame.iterationCount` and `LoopMarker.count` become **optional**,
  and the contract's §3.3 records why. TestBench's variables and call-stack
  labels render `?` for an absent count; nothing else in the extension reads
  it.
- `execution.maxLoopIterations` (number, default 25) joins `ExecutionConfig`,
  `defaults.ts` and the generated JSON schema.

### runner-core and TestBench

- `section-index.ts`: tails are call sites (liveness clause above), with the
  existing tests extended. `step-lines.ts` is unchanged — a control line is a
  `step`.
- A pre-flight refuses a dangling chain member — an `Else if` or `Otherwise`
  whose previous step line in the same flow is not a chain member, which is
  exactly what an `[input:]` between members produces — with the parser's
  wording, under its own TB code, beside the sections pre-flight (TB024).
- Frame labels tolerate an absent `iterationCount`.
- `testbench-native/package.json` patch bump, per the rule in CLAUDE.md.

### Docs and fixtures

- Handbook §3.4 becomes two sections: *Watching for a state* (today's text,
  with the consecutive-`If` grouping said out loud) and *Deciding and
  looping* (this story, with the `then` rule as the first sentence). §3.5
  "What does not exist" drops "loops" from its list and keeps "arithmetic".
  §5 gains "a section may be the tail of a control line".
- [docs/ai-test-authoring-guide.md](../docs/ai-test-authoring-guide.md)
  "Hooks and conditional steps" is rewritten to match, and the guard test
  over handbook fences covers the new examples.
- `templates/init/tests/control-flow.md` drives `fixtures/test-app` through
  one chain, one `While`, one `Repeat … until` and one `For each`, and a live
  suite `testbench-native/tests/integration/live/control-flow.test.cjs`
  asserts the taken/skipped pattern on the painted lines and the loop pass
  count. If the fixture app has no page that supports a bounded loop, it gains
  one small page for it, as [PR #117](https://github.com/pkent/ai-ui-automation/pull/117)
  added the Documents page.

## Decisions

1. **Bodies are sections; control lines are single numbered steps.** No
   indented sub-steps, no nested list grammar. Every parser, the painter,
   breakpoints, reports and code-behind are built on one numbered line being
   one step, and `###` is already the block.
2. **Prose keywords, not brackets.** `[if: …] Tail` was the runner-up: it is
   lexically strict and follows `[input: name] prompt`. It lost because it
   would sit beside the existing prose `If` as a second conditional form, and
   because the `Set` story already chose prose over a bracket alias for a
   framework-handled line. The claim rules above give prose the strictness
   where it matters.
3. **`then` is the opt-in.** It is what separates a decision from the
   existing watch, and it is also the separator the grammar needs. Resolution
   order for a step is: bracket directives, then the bare-name section match,
   then control forms, then `Set`, then prose — a step that *is* a section
   name is a call before it is anything else, as today.
4. **A decision is asked once, after the page settles.** A false answer is an
   answer. The 30 s of `waiting` re-asks exist for a page that is visibly
   mid-transition, not to wait for a state to arrive; the watch form does that.
5. **One judge call per chain, per pass.** Conditions are put to the model
   together, in order, first-holds-wins. Per-condition deterministic
   evaluation — a cached JavaScript predicate, a compiled code-behind entry
   returning a boolean — is a follow-on story ("compile the condition") and
   nothing here forecloses it: a guard already has a stable authored text to
   bind an entry to.
6. **The tail is one step of any kind.** This lifts the handbook's carve-out
   for skills and tools inside an `If` and gives `Set` a conditional form
   without touching `Set`'s grammar.
7. **Chains are static structure with runtime skipping.** Both tails are in
   the flat list; the untaken one is skipped. Nothing about the list changes
   during a run, so every consumer that indexes it is untouched.
8. **Loops re-enter by jumping back**, cloning the tail's frames per pass at
   run time. The alternative — pre-expanding the cap and skipping the rest —
   fits the flat model but paints and reports 25 copies of the body, most of
   them "not run", and needs a cap even for `For each`. The rows story already
   made every consumer handle the same line running N times; the only new
   fact is an unknown count, handled by making it optional.
9. **Caps fail, they do not exit.** A loop that hits its cap has not done what
   the author asked. The message names the cap and both ways to change it.
10. **`For each` takes a JSON array and nothing else.** No comma splitting: a
    list that came from a `Set` is text, and guessing a delimiter is how a
    value with a comma in it silently becomes two. `Set` cannot make a list;
    a plural read or a tool can.
11. **Both `Else` and `Otherwise`.** One spelling would be tidier; the two
    positions read best with different words. One regex accepts both.
12. **Control lines are not cached and not compiled; loop bodies opt out of
    the step cache; a compile whose slice touches a loop is refused.** Guards
    are dispatched, like `Set`. A chain compiles as any steps do — its untaken
    branch is simply not attempted. A loop does not: entries are placed at
    `spans[occurrence]`, occurrence is counted per step line, and a loop body
    offers N transcripts for one slot. So a whole-file compile of a looping
    file is refused before anything runs, with advice that can be followed —
    *Compile This Step* on a step outside every loop, and *Compile This Step*
    on the body lines of the section the loop runs (a body selection compiles
    detached, once), both proceed, because the refusal is scoped to the
    compile's own slice. Recording pass 1 and replaying the
    rest, the way rows record row 1, is its own story. (The draft of this
    decision said the opposite; §"What the build showed" says why.)
13. **Reports show every row of an untaken tail as skipped.** Honest, and
    what the matrix does. Collapsing is a presentation change to make with a
    rendered page in front of the reviewer.

## Tests

- `tests/control-line.test.ts` — every form parses; every claim-without-
  completion errors with the intended message; nothing without a claim
  parses; `[no-hooks]` strip; the split rules (first `then`, first comma,
  first `until`, cap suffix); case-insensitivity.
- `tests/parser-control-flow.test.ts` — chain-structure errors (`Otherwise`
  first, two `Otherwise`s, `Else if` after `Otherwise`, chain across a section
  boundary), tail refusals (control-line tail, `[input:]` tail), the `For
  each` bake-over refusals in a skill and in a looped section, and that a
  step equal to a section name resolves as a call even when it looks like a
  control line.
- `tests/expander-control-flow.test.ts` — control records and their ranges
  for a chain, a nested chain, each loop kind, a skill tail, a plain tail;
  liveness of a section only named in a tail; frame layout of an in-place
  section tail.
- `tests/control-flow-planner.test.ts` — the pure planner: skip ranges and
  `next` for every verdict, loop re-entry and pass counting, cap breach,
  `For each` cursor and bindings, `planForStart` inside a tail and inside a
  loop body, nested structures.
- `tests/step-grouper.test.ts` — extended: control lines neither group nor
  continue.
- `tests/condition-judge.test.ts` — the judge prompt carries the Values block
  with placeholders intact; `none` / `waiting` / malformed handling; the 30 s
  budget fails with the intended message (fake clock).
- `tests/test-runner-control-flow.test.ts` and
  `tests/api-server-control-flow.test.ts` — through the real entry points
  with a fake AI client: a chain takes the right branch and skips the other;
  `Otherwise`; `none` with no `Otherwise`; `While` with three passes and the
  back-filled count; `Repeat … until`; `For each` over a captured list and
  over a non-list; cap breach fails the guard; `startAt` inside a tail;
  `endAt` on a guard snaps to the structure; `[input:]` inside a chain is
  refused. The api-server suite asserts the emitted `frame:push` events carry
  `iteration` without `iterationCount` mid-loop, and `step:skip`-equivalent
  results for the untaken tail.
- The new handbook and guide fences parse — asserted directly in
  `tests/parser-control-flow.test.ts`, because the fence guard from PR #134
  (`tests/docs-handbook-examples.test.ts`) is not on this branch.
- `runner-core/tests/section-index.test.js` — tails are calls; near-miss
  tails are non-call steps with the right `nameStart`; a step that IS a
  section name resolves as a call before the control split (rung 2); the
  dangling-member pre-flight.
- `testbench-native/tests/*` — frame label with absent count.
- Live: `control-flow.test.cjs` against the fixture app, run at
  `--shards=1` first, then in the pool.

## Rollout

1. Merge; from the **main** checkout pull, `npm run build`, restart `:3100`
   (the judge and the planner are server code), package and install the
   bumped `testbench-native`, reload windows.
2. The handbook and guide changes ship with the same PR.
3. Nothing to migrate: no existing line claims a new form except a `While …`
   prose opener or a `Repeat … until …` prose step, and both are loops in
   intent. The fixture corpus is grepped for both before merge.

## Non-goals

- `Break`, `Continue`, or ending the test early from inside a body.
- A control line as a tail (nest through a section).
- Arithmetic, string functions or boolean operators in conditions beyond what
  a `Verify` sentence already says in words (`and`, `or`, `not` are words the
  model reads; nothing parses them).
- Deterministic condition evaluation — cached predicates, compiled
  code-behind guards (follow-on story).
- `{{x_index}}` or a pass counter as a variable inside a loop body.
- Collecting captures across passes into a list.
- Changing the watch form, its grouping, or its polling.
- A per-condition evaluation budget in config; the 30 s is a constant until
  someone needs it not to be.
- Parallel passes.
- `For each` over `${data.*}` arrays or a named data source (the rows story
  has the same non-goal, for the same shape questions).

## Open questions

- Should a skipped guard hover, in TestBench, say *which* condition won
  instead (e.g. "skipped — `Else if the Card checkbox is ticked` held")? The
  data is in the guard's result; the hover plumbing is the failure-hover path.
- The judge prompt's wording for "first that holds" against a model that
  wants to be helpful and pick the most plausible outcome. To be measured on
  the fixture, not argued.
- Whether `Repeat` should accept a `then`-less `If`-style comma before
  `until` for readability (`Repeat Click Load more, until …`). v1 says no;
  one split rule per keyword.

## What the build showed

Three stages (grammar and planner; runtime; fixture and docs), two adversarial
review rounds with a fix round after each, a full unit run and one live run of
the fixture suite. What follows is where the built thing differs from the spec
above, and what the live run taught. The spec sections were left as written so
the reasoning stays legible; this section is the record of what shipped.

### The spec was wrong about compile

Decision 12 promised a looping file would compile by recording pass 1. It does
not, and the reason is structural: a code-behind entry is placed at
`spans[occurrence]`, occurrence is counted per step line, and a loop body hands
the compiler N transcripts for one slot. Refusing was the honest answer. The
first cut refused the whole file whenever any loop existed, which made its own
advice ("compile the section the loop runs, on its own") impossible to follow —
that section is in the same file. The refusal is now scoped to the compile's
slice: a bounded *Compile This Step* on a step outside every loop proceeds,
the same command on the body lines of the looped section proceeds (a body
selection compiles detached, once — there is no separate "compile this
section" command), and a whole-file compile of a looping file is refused with
advice naming both.

### Three traps found by reading, before anything ran

- **A control line looked like a labelled skill call.** `parseInvocation`
  accepts any text before `[skill:` as a *label*, so
  `If {{plan}} is "pro", then [skill: enable_pro_features]` — the story's own
  example — parsed as a labelled call and ran the skill unconditionally. The
  expander now checks the control form before a *labelled* invocation; a step
  that genuinely opens with `[skill:` still wins (rung 1 is untouched). The
  guard's `toolCalls` entry is forced null for the same reason.
- **The server only expanded when sections or skills were present.** A file
  with one chain and nothing else shipped `If …, then …` to the model as prose.
  The expansion gate now also fires on a control line, on both the CLI and the
  server.
- **TestBench had never painted a skipped step.** The server has emitted
  `step:pass` with `output: 'skipped'` for an unmatched watch member since the
  lookahead story; six client surfaces mapped it to ✓ (the run gutter, the
  compile gutter, the run log, the compile log, the panel's own run log, the
  Test Explorer). One helper now decides, and the watch form's untaken members
  paint grey for the first time too.

### The planner, as built

`src/runner/control-flow.ts` is not quite the API in §Design. `planAfterGuard`
takes a tagged `GuardVerdict` (`chain` / `condition` / `list` / `resume`);
there is a fourth entry point, `planAtGuard`, because a `Repeat`'s first pass
and a `For each`'s later passes must be able to say "ask nobody"; `planForStart`
takes and seeds a `ControlState`; `ControlPlan` gained `selected`,
`capBreached` and `loopEnded` (which is what the report back-fills counts
from); `snapEndAt`, `parseListValue`, `exitFrom` and `resetNestedState` are
exported beside them. The last two are the two bugs review 1 found and the
runtime stage first patched a layer too high: every structure exit must walk
*outward* through enclosing structures (an inner chain that decided nothing as
the last step of an outer member was making the outer `Otherwise` evaluate —
both branches of one decision ran), and a new pass must reset the counters and
cursors of every loop nested inside it (a `For each` inside a `While` ran its
list once, then zero times). Both live in the planner now, pinned by the
reviewer's own reproductions.

### Rows, results and the model's memory

- **A guard row is produced per evaluation, not per visit.** A `Repeat`'s first
  pass and a `For each`'s passes after the first ask nobody and record no row.
  A `Repeat` report therefore reads body, guard, body, guard.
- **The guard that decided nothing is the skipped row that carries the
  reasoning.** A chain with no `Otherwise` and no condition holding leaves that
  one trace.
- **`## Prior Steps` names the member that held.** The first cut wrote the
  history line from the guard that was *asked* with the status of the one that
  was *selected*, so a run that took the `Else if` told every later step that
  the `If` held. Fixed in all three loops, with a "did not hold" line per losing
  member.
- **A plain-instruction tail shares the guard's source line**, so one authored
  line produces two report rows and paints twice. Their statuses agree whenever
  the tail is skipped; a taken tail can fail on its own, so the guard's row
  reads passed above the tail's failed one.
- **The cap sentence quotes the condition**: *"the loop reached its cap of 25
  passes (execution.maxLoopIterations) and "the Next button is enabled" was
  still true; raise the cap on the line with `, up to N times`, or check the
  exit condition."*
- **The judge's budget is two module constants**, 30 s and a 3 s re-ask, and
  `parseBranchedResponse` gained `actionsOptional` for the judge alone: a
  judge told to send an empty `actions` array that omits the key has obeyed.

### Frames, painting and the three runners

- Per-pass frame clones are `<original>~g<guard>i<n>`, `iteration` is stamped
  on the outermost clone only, and `iterationCount` is absent for `While` and
  `Repeat` until the loop ends. A loop nested in another loop's body clones
  against the current pass's own alias map — the first cut asked the whole
  stack and gave the inner loop no frames of its own.
- TestBench does not render `Name (3/?)` anywhere; runtime loops pass through
  the row machinery untouched (`startSectionIteration` returns early for a
  section with no table). Only the rendered report shows the band.
- The Electron runner is a real third copy and got the hooks its pointer can
  reach: `planAfterStep` through one `advance` helper (its `Set` / `[input:]`
  / `[interactive]` paths had bypassed it and truncated a loop whose body ended
  in one), `planForStart` when the debugger moves the pointer (seeding the
  pass count and the `For each` cursor rather than resetting them, and
  re-reporting a skipped row only when a new pass makes it owed again), and a
  `skipped` status on its IPC and gutter. It has no `startAt` or `endAt`, so
  `snapEndAt` has no caller there.
- **Hooks are a fourth carve-out.** A control line in `## Hooks` or in
  `execution.defaultHooks` is prose, with a warning; a hook entry is never
  validated at parse time, and an unevaluated guard plus an unconditional tail
  is worse than one prose step.
- The chain rule is enforced three times with one wording — parser, expander,
  runner-core pre-flight (TB032) — including its closed half (`Else if` or a
  second `Otherwise` after an `Otherwise`), which the first cut enforced in the
  parser only.

### What the live run found

`control-flow.test.cjs` ran the two fixtures in 425 s. The chain painted
`pass, skip, pass, pass, skip, skip, skip, skip` across its eight lines; the
`While`, `Repeat` and `For each` produced 4, 3 and 1 guard rows; every band
read `of 3` after back-fill; `{{account}}` was bound to Everyday, Savings,
Travel in order. Two things were wrong, neither in the planner:

- **A `For each` guard line stayed `running` after the run.** The server
  emitted `step:start` for every guard visit but only a closing `step:pass`
  when the visit produced a row; a `For each`'s revisits, including the one
  that finds the list exhausted, produce none. A guard's opening signal — the
  server's `step:start`, the Electron runner's `runner:step-start`, the CLI's
  step header — is now emitted only for a visit that will produce a row, so
  the console announces exactly the guard visits the report records.
- **The DOM snapshot served a checkbox's `checked` attribute, not its live
  property.** `Untick the Cash checkbox` ran, and the very next judge saw
  `checked` because `getAttributes` reads `el.attributes`, which a click never
  changes. Any condition or assertion about a toggled checkbox, radio or
  `<option>` had always read its page-load state; nothing before this feature
  had toggled one and then asked. Fixed in `capture-dom.js` for checkbox and
  radio `checked`, option `selected` and live `value`; where live state and
  markup agree the snapshot text is unchanged, except that a `<select>` now
  shows its value and its chosen option's `selected`, which the attribute walk
  never could. A field whose `type`, `autocomplete`, `name`, `id` or
  `aria-label` marks it as a secret shows `value="***"` in place of its live
  value — a show-password toggle that flips the field to `type="text"` must
  not turn the snapshot into a leak, and the field rule is deliberately wider
  than the parameter rule (`pwd`, `pass…`, `pin`, `credential`, `secret`,
  `token`) because a field's value is not one the run owns. Two of those need
  care: JavaScript's `\b` counts `_` and digits as word characters, so
  `\bpass\b` and `\bpin\b` both let `user_pass` and `pin_code` leak. `pass` is
  now fenced by lookarounds that exclude only `passenger`, `passport`,
  `bypass` and `compass`; `pin` is matched as a whole token after splitting
  camelCase (`pinCode`, `atmPin`, `pin1` mask; `shipping` and `spinner` do
  not), which leaves run-together lowercase compounds such as `newpin` as the
  known edge. `placeholder` is read by that
  password-only rule alone, never by the parameter rule's bare `key`, so a
  field whose only identity is `placeholder="Password"` is masked while a
  search box hinting "Search by keyword" keeps its value. The judge and the
  watch poller now redact their snapshots the way the step prompt always has.
  The `-otherwise` fixture exists to take the branch the first fixture does
  not, and that is what found it.

The second live run, after those fixes, passed both fixtures end to end and
found one more: **a breakpoint on a loop body line fired on the first pass
only.** The server remembers consumed breakpoints by flat step index, per
batch, so a Continue inside one batch does not re-pause on the line it stopped
at (a main-flow resume is protected by the client's trim instead), and a loop
re-runs the same indices. The memory is now dropped for a loop's body (and its
guard) each time a new pass begins, so the contract above — a section-body
breakpoint fires on every pass — holds, and the within-batch Continue is
unchanged.

Two lessons for the suite itself: a breakpoint on a *section-body* line pauses
server-side with the request held open, so the controller's `isRunning` stays
true and `isStepPaused` is the flag to wait on; and the fixture app's pinned
port 8787 is shared across worktrees, so a run that adopts another worktree's
older app gets a 404 for a page only this branch has.
