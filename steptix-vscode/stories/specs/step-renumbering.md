# Step Renumbering Spec

Right-click the line-number gutter in a test file and pick **Steptix:
Renumber Steps**. If you have step lines selected, just those are renumbered,
continuing from the step above them. With nothing selected, the whole file is
renumbered: the main flow counts 1..N and each `### Section` body restarts
at 1.

This is the "I inserted a step in the middle and now every number below it is
wrong" fix. Today you edit each ordinal by hand; after this, one menu click.

**Before** (a step was inserted after `2.`, and the `Login` body grew):

```markdown
## Steps
1. Open the site
2. Login
2. Check the dashboard shows today's date
3. Sign out

### Login
1. Go to the login page
1. Type "{{username}}"
2. Click Sign in
```

**After** right-click → Renumber Steps with nothing selected:

```markdown
## Steps
1. Open the site
2. Login
3. Check the dashboard shows today's date
4. Sign out

### Login
1. Go to the login page
2. Type "{{username}}"
3. Click Sign in
```

Only the leading ordinals changed. Every character after `N. ` — including
spacing — is untouched.

## 1. Goal

One command, `steptix.renumberSteps`, title **Steptix: Renumber
Steps**, that rewrites the leading ordinal of step lines so numbering is
sequential. Two modes, chosen by the editor selection:

- **Selection contains step lines** → renumber exactly those, each continuing
  from the step above it in the same scope. Unselected steps are never
  touched.
- **No selection, or a selection with no step lines in it** → renumber every
  step in the document. The main flow numbers 1..N; each section body
  restarts at 1.

**Not in scope:**

- Auto-renumbering as you type, on save, or as a code action / quick fix.
- Reordering, inserting, or deleting steps — numbering only.
- Renumbering inert steps (numbered items under a `####`-or-deeper heading
  with text) or numbered lists outside the `## Steps` span. They are not
  steps; a "renumber steps" command that touched them would be claiming they
  are.
- Any change to how steps are *matched* or *run*. Ordinals are presentation:
  `extractSteps` strips the `N. ` prefix before anything reaches the wire, so
  renumbering changes no instruction text and breaks no code-behind
  recording.

## 2. What counts as a step

Exactly what runner-core's `classifyLines` says
([runner-core/src/step-lines.ts](../../../runner-core/src/step-lines.ts)) —
no new grammar, no fourth copy of the rules:

- `step` (main flow) and `section-step` (body of a `### Name` inside
  `## Steps`) are renumberable.
- `section-heading` resets the counter — this is what makes each section
  start from 1. A hashes-only `###` (empty name) is also a `section-heading`,
  so its body restarts too; renumbering doesn't care that the file would be
  refused at run time.
- `inert-step`, `frontmatter`, `heading`, `prose`, `blank` are untouched.
  Indented numbered items and numbered lists outside the Steps span already
  classify as `prose`, so they are excluded by construction.
- A wrapped step's continuation lines classify as `prose` — only the first
  physical line carries the ordinal, so wrapping needs no special handling.

One correction on top of the classifier: `classifyLines` deliberately does
not track ``` fences, so a numbered line inside a fence within the Steps
span classifies as a step (the same blindness step-region-core.ts guards for
completion). Completion merely offers a dropdown there; renumbering REWRITES
text, so fenced lines are invisible to the walk — never rewritten, never
feeding the counter, and a fenced `###` never restarting it. A docs file
whose numbered examples are all fenced therefore yields zero edits.

## 3. Numbering rules

One walk over the classified lines, top to bottom, with a counter `prev`
(starting at 0):

1. On a line inside a ``` fence: no effect, whatever it classifies as (§2).
2. On a `section-heading`: reset `prev` to 0.
3. On a renumberable line that is a **target**: its new ordinal is
   `prev + 1`. Record an edit if that differs from what's written;
   `prev` = the new ordinal.
4. On a renumberable line that is **not** a target: `prev` = the ordinal as
   written (parse `/^(\d+)\./`) — unless that value exceeds JS's safe-integer
   range, in which case it doesn't feed the counter (an inexact seed would
   corrupt every target below it, `String(1e21 + 1)` being `"1e+21"`).
5. Anything else: no effect.

Targets are the selected step lines when the selection contains any, else
every renumberable line. Renumber-all is therefore the same algorithm with
everything targeted — there is exactly one numbering routine.

Consequences worth stating:

- Selecting the tail of a list after inserting a step gives the natural fix:
  the first selected step becomes (step above it) + 1, and the rest follow.
- Selecting all steps of a scope yields 1..N, identical to renumber-all.
- A partial selection can leave the file non-sequential overall (renumber the
  duplicate `2.` alone and the following unselected `3.` now collides).
  That's the contract — unselected steps are never touched. Renumber-all is
  the one-click cleanup.
- A selection spanning the main flow and a section body renumbers each part
  in its own scope; the reset at the heading keeps them independent.

The edit itself replaces only the leading digit run — the range from column 0
to the end of the digits — with the new ordinal. `12. Foo` → `3. Foo`
shortens the line; `9. Foo` → `10. Foo` lengthens it; the `.`, the spacing
after it, and the instruction text are byte-identical before and after.

## 4. Command, menu, selection

### 4.1 Where it appears

- `editor/lineNumber/context` (the gutter right-click menu), gated on
  `steptix.activeFile` like every other entry there, in a new group
  `2z_edit@1` — lexicographically between `2_run` and `3_clear`, so it
  renders as its own separator block: an edit action, not a run action and
  not a clear action.
- Command palette, gated on `steptix.activeFile`.
- No keybinding, no editor-title button.

### 4.2 What "selected" means

The same thing it means for Run Selected Step(s) — the lines covered by
every *range* selection, a cursor with no highlighted range not counting
(that's the renumber-all case) — with **one narrowing**: a selection that
ends at column 0 of a line does not target that line
(`selectionLinesForEdit` in
[commands/index.ts](../../src/extension/commands/index.ts)). Every line-wise
gesture — gutter click/drag, Shift+Down, Ctrl+L, triple-click — produces
exactly that shape, so without the trim a whole-line selection would also
rewrite the step *below* it. This is the same rule the anchor math applies
to edits (`effectiveEndLine`, step-lines.ts: a range ending at column 0
stops before any of that line's content). Run Selected keeps the untrimmed
helper deliberately — an extra step in a run is visible; a silent rewrite is
not.

The gutter menu passes `{ lineNumber }` to the command; it is accepted and
ignored. Renumbering one step because the user happened to right-click on it
would make the two modes hard to predict — selection is the only input, for
parity with Run Selected.

### 4.3 Guards and feedback

- No active editor, or the file isn't a test file → the existing
  `notifyNoActive()` status-bar message. (The menu's `when` clause already
  hides the entry; this covers the palette path.)
- Edits applied → status bar: `Steptix: renumbered <n> step(s)` (2.5 s).
- Nothing to change (numbering already correct, or the file has no steps) →
  status bar: `Steptix: steps already numbered` (2.5 s). No error — the
  command is idempotent.
- Edit rejected (the buffer changed between compute and apply — a keystroke
  or a disk-change reload in flight) → status bar: `Steptix: renumber not
  applied — the document changed; run it again` (2.5 s). Never a success
  message for an edit that didn't land.

### 4.4 How the edit applies

One `editor.edit(...)` call containing every per-line replacement — a single
undo step, applied to the buffer (dirty or not), never saved. The call's
boolean result is checked: VS Code rejects the whole batch if the document
changed underneath it, and the command reports that (§4.3) rather than
claiming success — the same discipline as the `applyEdit` check in
codebehind-diff.ts. No gating on run state: line numbers don't move, so
breakpoints, run statuses, and the resume anchor all stay where they are
(the anchor's touched-line snap re-resolves to the same line, which is
still a step).

## 5. Edge cases

| Scenario | Behavior |
|---|---|
| Numbered lines inside a ``` fence | Invisible to the walk: never rewritten, never feed the counter, a fenced `###` never resets it. A selection covering only fenced lines counts as "no steps selected". |
| Whole-line selection (gutter drag, Shift+Down, Ctrl+L — ends at column 0 of the next line) | The trailing line is not targeted (§4.2). |
| Unselected step with an ordinal beyond `Number.MAX_SAFE_INTEGER` | Keeps its text and does not seed the counter — the next target continues from the last exact ordinal. |
| Selection covers only prose/headings/blank lines | No step lines selected → renumber-all. |
| Selection includes a step line plus prose around it | The step lines in it are the targets; the prose contributes nothing. |
| Multi-cursor / multiple selections | Union of all range selections, same as Run Selected. |
| Step ordinals with leading zeros (`007.`) | Digit run replaced wholesale with the decimal ordinal. |
| Numbered item under `#### Heading` (inert) | Untouched, and it does not advance `prev` — it isn't a step. |
| Numbered list in `## Notes` (outside Steps span) | `prose` — untouched. |
| CRLF files | `classifyLines` splits on `\r?\n`; edits address (line, column) ranges, so line endings are preserved. |
| File with `## Steps` but zero steps | Zero edits, "already numbered" message. |
| Renumber during a paused run | Allowed; per-line state is keyed by line number and lines don't move. |

## 6. Implementation plan

**Pure logic** — `steptix-vscode/src/extension/renumber-core.ts`, no
`vscode` import, mirroring the `step-region-core.ts` /
`section-diagnostics-core.ts` pattern:

```typescript
export interface RenumberEdit {
  /** 1-based line. */ line: number;
  /** Length of the leading digit run to replace. */ digits: number;
  /** The ordinal to write. */ ordinal: number;
}
/** Empty selectedLines ⇒ renumber everything. */
export function computeRenumberEdits(text: string, selectedLines: number[]): RenumberEdit[];
```

Plus a `renumberText(text, selectedLines): string` convenience used by tests
(and by nothing else) so cases read as before/after documents.

**Command** — `steptix-vscode/src/extension/commands/index.ts`: register
`steptix.renumberSteps` next to `runStepHere`; guards, `selectionLines`,
`computeRenumberEdits`, one `editor.edit`, status-bar message.

**Manifest** — `steptix-vscode/package.json`: command declaration, the
`editor/lineNumber/context` entry, the `commandPalette` entry, and the
patch-version bump (CLAUDE.md rule).

**Changelog** — one entry under `## Unreleased` in the root
[CHANGELOG.md](../../../CHANGELOG.md).

**Tests**

- `steptix-vscode/tests/renumber.test.js` (`node --test`, imports the `.ts`
  directly like its siblings). Cases: renumber-all main flow; sections
  restart at 1; hashes-only heading restarts; inert steps and indented items
  untouched and not advancing the counter; numbered list outside the span
  untouched; tail selection continues from the step above; selection at
  scope start gets 1; selection spanning main flow + body; prose-only
  selection falls back to all; already-correct returns no edits; multi-digit
  and leading-zero ordinals; wrapped-step continuation untouched; CRLF text;
  fenced lines (untouched, no counter feed, no reset from a fenced `###`,
  all-fenced document yields zero edits, fenced-only selection falls back to
  renumber-all); unsafe-integer ordinal not seeding the counter.
- Integration cases (`tests/integration/suite/`, the fast FakeApiClient
  harness): no-selection renumber of a fixture; single undo restores;
  second run changes nothing; a whole-line tail selection (ending at column
  0 of the next line) changes only the selected steps; a whole-line
  selection of one correct step changes nothing; a breakpoint set on a
  renumbered line survives. These prove the wiring — real selection shapes,
  one-edit application — which the pure tests can't. (Registration is
  pinned centrally by activation.test.cjs's command sweep.)

## 7. Acceptance criteria

1. Gutter right-click on a test file shows **Steptix: Renumber Steps** in
   its own separator group; non-test files don't show it.
2. With no selection, the before/after example at the top of this spec is
   reproduced exactly — main flow 1..4, section body 1..3, nothing else
   changed, one undo restores the original.
3. With the last two main-flow steps of the "before" example selected, only
   those two lines change (`2.`→`3.`, `3.`→`4.`); the `Login` body keeps its
   duplicate `1.`s.
4. Running the command twice in a row: the second run makes no edit at all
   (so no undo step) and reports "already numbered".
5. Breakpoints and painted run statuses survive a renumber on the same lines
   (the breakpoint half is pinned by an integration case).
6. Numbered lines inside ``` fences are never rewritten and never shift the
   ordinals of real steps; a docs file whose examples are all fenced reports
   "already numbered".
7. A whole-line selection — the shape gutter drags, Shift+Down, Ctrl+L and
   triple-click produce — never touches the line below the visually selected
   block.
8. `npm run typecheck:extension`, `npm test`, and `npm run build` pass in
   `steptix-vscode/`; the new unit and integration tests are green.
