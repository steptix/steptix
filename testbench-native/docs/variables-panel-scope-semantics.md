# Variables panel — scope semantics

Notes on what the Variables view in `testbench-native` actually shows, why
the design has the rough edges it does, and what's planned to file them
down.

## What the view renders today

For each step the server completes (`step:pass` or `step:fail`), it
emits a `frame:scope` event carrying:

```ts
{
  frameId: '' | 'fN',                // '' = test (root) frame; 'fN' = a skill frame
  scope: Record<string, string>,     // copy of the runtime resolvedParameters
  bindings?: string[],               // dotted names a `For each` pass bound here
  unmask?: string[],                 // the run's `## Config: unmask:` names
}
```

`bindings` and `unmask` are how the values get masked correctly, and both are
optional only so an older server still type-checks. The scope is a COPY, and
whose a dotted name is lives in a registry keyed on the server's live map —
so without `bindings` the client cannot tell a loop's `payment.keyword` (the
page's word, readable) from a data file's `user.apikey` heading (the author's
word, starred by the report) and gets one of them wrong whichever rule it
picks. `bindings` is sent on every event, empty list included: absent means
"an older server said nothing" and keeps the pre-wire reading, `[]` means
"this run bound nothing". See `docs/specs/SPEC-structured-table-reads.md`
§7.6.

The extension's `RunController` accumulates these in a per-frame map
(`scopesByFrame: Map<frameId, scope>`), keeps the two masking fields beside
them in `scopeMaskingByFrame`, and exposes `currentScope()` /
`currentScopeMasking()` returning the **top frame's** latest pair (falling
back to the test frame).

The Variables tree provider renders the resulting `currentScope()` as
`name = value` rows, ordered by runner-core's `compareVariableNames` rather
than a plain `.sort()`. It splits each name on `.` and compares segment by
segment, with two rules a code-unit sort does not give: a shorter name leads
the longer ones it prefixes (`payment` before `payment.payee`), and a
`_`-leading segment leads its siblings, so `payment._row` comes before
`payment.Amount` and `payment.payee`. §7.4 wants the row number ahead of the
columns, and `_` sits between the upper- and lower-case letters in code-unit
order, which delivered that by luck for `payee` and not at all for an
`Amount` alias. The view's title flips between `Variables (test)` and
`Variables (skill: <name>)` depending on the active frame.

## Why the scope payload is "flat" (and looks leaky)

The server keeps **one** runtime variable map — `resolvedParameters` —
shared across the whole run including any skill descents. The expander
( `src/skills/expander.ts` ) namespaces a skill's internal variables to
`__skillN_x` so two skills' internals don't collide, and adds the
caller's output alias as a separate entry. After a skill exits, **none
of these get garbage-collected** — the namespaced names linger in
`resolvedParameters` for the rest of the run.

So a test that ran `[skill: foo]` once will, for the rest of the run,
have entries like:

```
caller_var         = whatever
target_url         = https://...      ← output alias the caller wrote
first_result_url   = https://...      ← skill's declared output name
__skill1_query     = OpenAI GPT-5     ← skill's internal var
__skill1_something = ...              ← more skill internals
```

The Variables view inherits this — the `__skillN_x` names would
otherwise clutter the test-frame view with noise the user never wrote.

## Phase 4.1 mitigations (current)

Two view-side filters apply:

  1. **Test-frame filter.** When the active frame is the test (root)
     frame, entries matching `/^__skill\d+_/` are hidden. The user
     sees only the variables they authored / captured at the test
     level.
  2. **Skill-frame passthrough.** When the active frame is a skill,
     all entries are shown — including `__skillN_x` — because inside
     the skill those ARE the locals (just renamed for namespacing).

Caveats:
  - The duplicate `first_result_url = ...` / `target_url = ...` pair
    when a skill aliases an output is still visible at the test frame.
    Both names are the user's; the view shows both. Not ideal but
    accurate.
  - The view doesn't yet reverse-resolve the rename inside a skill
    frame. So inside `duckduckgo_search` you'd see
    `__skill1_query` rather than the `query` the author wrote.

## Phase 4.B (planned)

Replace the view-side filters with **proper per-frame scope** emitted
by the server:

  - The expander threads its per-instance rename map
    (`internalRenames` + `outputRenames` in `applySkillScope`) into the
    `ExpandedFrame` payload.
  - The server's `frame:scope` event carries the renamed-back map: the
    skill's scope shows the names the author wrote, not their
    namespaced form. Caller-side aliases stay as they are in the
    caller's frame.
  - The view trusts the server's payload and renders it verbatim —
    no string-pattern filter needed.

This will also fix the duplicate-pair issue (the test-frame scope will
only contain the caller's alias; the skill scope will only contain the
skill's declared output name).

## What the view does NOT do

  - **Edit values.** Read-only by design (matches the spec at
    [`step-into-design.md`](step-into-design.md)). A REPL-style edit
    would be a separate feature.
  - **Show value history.** Only the latest scope per frame is kept.
    Step-back through prior scopes was discussed and ruled out for
    the same complexity reasons.
  - **Copy values.** No "copy value" command yet; you can hover for a
    tooltip with the length. Easy follow-up.
  - **Update mid-step.** `frame:scope` fires on step boundaries, not
    while a step is running. A long AI step that internally captures
    a value won't surface it until the step completes.
  - **Mask a bare secret under an innocent name.** `maskIfSecret`
    (runner-core) asks the NAME first — `password`, `token`, `apikey`, … —
    and masks a secret-named value whole. Since review round 2 a name that
    says nothing no longer ends it: the value is then scanned as a RECORD,
    so `mydata = {"user":"bob","password":"abc"}` renders with the
    `password` column starred even though `mydata` says nothing. What still
    renders unmasked is a *bare* credential under an innocent flat name —
    `mydata` holding a JWT string and nothing else. There is no shape to
    read there, only the value's own characters, and sniffing those would
    star ordinary text.

## Files

  - View provider: [`testbench-native/src/extension/variables-view.ts`](../src/extension/variables-view.ts)
  - Server emit site: [`src/server/session-manager.ts`](../../src/server/session-manager.ts) (`frame:scope` after `step:pass` / `step:fail`)
  - Expander rename scheme: [`src/skills/expander.ts`](../../src/skills/expander.ts) (`applySkillScope`)
  - Mask helper: [`runner-core/src/repl.ts`](../../runner-core/src/repl.ts) (`maskIfSecret`)
