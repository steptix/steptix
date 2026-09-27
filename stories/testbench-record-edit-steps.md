# Record Steps: edit, delete and insert steps while you record

**Status:** decided 2026-09-28, building. Extends `docs/specs/SPEC-record-steps.md`
and `stories/testbench-record-toolbar.md` (its §"Decisions confirmed" item 1,
"editor edits of recorded lines are overwritten, with a warning", is replaced
by this story).

## What we're building

While a recording runs you can already add steps of your own. This change lets
you change the ones already there: reword any step, delete one, or put a new
one between two others, from the toolbar's Steps so far drawer or straight in
the test file. Whatever you change stays changed, and the model works around
it.

- **You click** step 4 in the drawer, `Click Payments in the main menu`, and
  change it to `Open Payments from the side menu`, then press Enter. **You get**
  that wording in the file as step 4. The next drafts never put the old words
  back, and the model doesn't write another step for that click.
- **You press ✕** on `Click the Help icon` in the drawer, a misclick the model
  dutifully wrote down. **You get** the step gone from the file, and the click
  behind it struck through in the TestBench panel, so no later redraft brings
  it back. Restore puts both back.
- **You delete** the line `6. Type {{search}} into the Search field` in the
  test file. **You get** the same as ✕: the step and the typing behind it are
  dropped, and `search` leaves `## Parameters` if nothing else uses it.
- **You edit** line 3 of the recorded block in the file and move the cursor
  away. **You get** your wording kept, numbered by the recording, and the
  recording carries on below it. (Today the next draft overwrites your edit
  and warns you.)
- **You press +** between steps 2 and 3 in the drawer and type
  `Verify the cart shows 2 items`. **You get** that line as the new step 3,
  exactly as typed.

## The author's decisions (2026-09-28)

1. **No step is ever locked against the author.** Any step can be edited or
   deleted at any time, any number of times: steps the model wrote, steps you
   added, steps typed in the file, and steps sitting before one of yours.
   Editing a step locks nothing else, either. "Locked" stays an internal idea
   of the draft engine (steps the MODEL may no longer rewrite); it is no longer
   shown to the author, so the lock glyph goes from the drawer and the panel.
2. **Deleting a step the model wrote drops the recorded actions behind it**,
   exactly as ✕ on those actions in the panel does today: struck through,
   restorable, never redrafted back in.

## How it behaves

**An edited step is yours.** Its text is kept exactly as you wrote it (a
leading number or list marker aside, which is the recording's to give). It
still stands for the actions it described, so the model neither rewords it nor
writes a second step for those actions. It shows as `yours` in the drawer and
the panel. Editing it again, or editing it back to the model's words, is fine;
back to the model's exact words, it is the model's again. Only its text is
fixed: where the model may rewrite around it is the engine's business, as long
as the author never sees an edit undone or duplicated.

**Which actions a step stands for.** To drop the actions behind a deleted
step, the recording has to know them. The model now says, for each step it
writes, which of the recorded actions (by the numbers it is shown) that step
describes. The engine checks the answer (only actions this call covers, each
action in at most one step, in order) and keeps the mapping across redrafts.
When the model's answer is missing or doesn't check out, the engine infers it
conservatively: the call's actions go to its steps in order, nearest step
first, never to a step from an earlier call. An action no step describes
(a focus click the model folded away) belongs to no step and is never dropped
by a delete. Events that ride with an action (typing, a choice, a tick) go with
it.

**Delete.** ✕ in the drawer or the panel, or deleting the whole line in the
file. A model step: the step goes at once, with no model call, and its actions
are dropped. A step of yours: it goes, as the toolbar's Undo of it does today.
Parameters no remaining step uses leave `## Parameters`. The bar says
`Removed "…" [Restore]`, and the panel strikes the step and its actions.
Restore puts the step back exactly where it was, with its actions, with no
model call when nothing changed since; if the draft moved on, it goes back
after the step that was before it. Ctrl+Z of the line deletion in the file is
a Restore.

**Insert between.** `+` between two rows of the drawer opens the Add step box
for that place; in the file you already type a new line between two recorded
lines. Both are the existing add-step with `afterStep`.

**In the file.** A recorded line you change is **being edited** from your
first keystroke: the recording stops writing that line (it still writes the
lines around it, and still renumbers). It counts as an edit when the cursor
leaves the line, the window loses focus, or you press Stop — the same moments
a typed line counts. If the line is then empty, or only a number, it is a
delete. Changing only the number is not an edit: numbers stay the recording's.
Deleting whole lines is a delete as soon as the lines are gone (each line, one
delete). Your text is never lost and never written twice: if the model
rewrote the step while you were editing it, your edit replaces whatever now
stands for the same actions.

**Secrets.** An edit holding a secret value the recording knows is handled as
an Add step with one is: from the drawer or the panel it becomes `{{name}}`
with `name: $NAME`; from the file it is refused with the reason, and the line
stays as you typed it (TestBench logs it by line number, never by quoting).

**Cancel and Ctrl+Z after Stop** take out every step the recording wrote,
including the ones you reworded, since they describe actions Cancel throws
away. Lines you typed as new steps stay, as today.

**Unchanged:** the toolbar's Undo walks back actions and added steps, not
edits (Ctrl+Z in the file undoes a file edit). Pause, Add check, drop/restore
of actions in the panel, and every rule about the file the recording cannot
prove it wrote (it stops writing live rather than overwrite anything).

## The drawer

Each row gets, on hover or keyboard focus: click the text (or Enter on the
focused row) to edit it in place (Enter saves, Esc cancels, an empty save is a
delete), a ✕ to delete, and a `+` in the gap below it to insert there. A
deleted row stays in the list, struck through, with Restore, until the next
step lands. Rows are keyboard reachable (Tab/arrow keys) with visible focus.
The foot text changes from "Read-only here…" to a one-line hint. The row
glyphs follow the existing design's icon set; no lock glyph.

## The panel

Steps so far rows get ✕ / Restore (delete), and `yours` on an edited step.
The action list shows actions dropped by a step delete as struck, like any
dropped action, and their ✕ restores them one by one (restoring any of them
redrafts, as today). Editing stays in the file and the drawer.

## The wire, exactly

Additive; an old client or server ignores what it doesn't know.

Model answer (server-internal): each step may carry the action numbers it
describes — `"steps": ["…"], "stepActions": [[4], [5, 6], []]` (parallel to
`steps`, the numbers as the prompt shows them). Prompt: every draft step shows
`actions: [n…]` it stands for, and `edited: true` on an author's rewording
(rule: keep it exactly; never write another step for its actions).

`record:draft` gains:

```ts
ids: string[];        // one stable id per step: kept while the step is unchanged in place,
                      // new when the model writes or rewrites it; an author step keeps its s-id.
                      // Never collides with an action id or an author-step id.
edited: number[];     // indices of steps whose text is the author's edit (subset of what the drawer shows as yours)
```

Controls (`POST /sessions/:id/record-steps/control`):

```ts
{ action: 'edit-step'; id: string; text: string; source: 'editor' | 'panel'; revision?: number }
{ action: 'drop'; id: string }      // now also takes a step id: deletes the step and drops its actions
{ action: 'restore'; id: string }   // ...and puts it back
```

`edit-step` answers 202; `{ ok: true, ignored: "<why>" }` when it cannot apply
(the id is unknown and no step stands for its actions any more; a secret from
the editor; an empty text is not an edit — send `drop`). The drawer's edits and
deletes go through the page binding with the document token, like its Add step.

New frames:

```ts
{ type: 'record:edited'; id: string; text: string; source: 'toolbar' | 'editor' | 'panel' }
// record:dropped gains the actions a step delete dropped (or a restore restored):
{ type: 'record:dropped'; id: string; dropped: boolean; source: 'toolbar' | 'panel' | 'editor'; actions?: string[] }
```

TestBench keys file lines to step ids from `record:draft.ids`, sends
`edit-step` / `drop` / `restore` with those ids, and shows `record:edited` and
`record:dropped` in the panel's action list.
