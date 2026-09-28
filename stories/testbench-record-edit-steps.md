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

## What the server half built

Built in `src/`: the draft engine (`src/recorder/draft-engine.ts`) keeps an id
and the actions it stands for on every step, and gained edits, step deletes and
step restores; the prompt (`src/ai/prompts.ts`) asks for `stepActions`, shows
each step's `actions`, marks `edited` steps and has rule A4; the run
(`src/recorder/record-steps-run.ts`) takes `edit-step` and step ids on
`drop` / `restore` from the route and from the drawer; the drawer itself is in
`src/browser/scripts/record-toolbar.js`. The wire is as above. Pinned by
`tests/record-steps-edit.test.ts` (the engine, the prompt and the answer, and a
150-seed random interleaving), eight new cases in
`tests/api-server-record-steps.test.ts` (the real routes, page and bar) and
eleven drawer cases in `tests/record-steps-toolbar.test.ts` (real Chromium,
read and driven through DevTools, `tests/record-toolbar-cdp.ts`).

Decided while building, where the story left it open:

- **The inferred mapping.** When the model's `stepActions` is missing or does
  not check out, each action with the events recorded before it is one group,
  and the groups go to the call's steps one each **from the last** — the newest
  step is the one the newest action asked for — with any earlier groups left
  over going to the first step (a focus click a `Type` step folded away, the
  menu a "Click Payments in the main menu" opened). A step the call left
  unchanged in place keeps what it stood for. The story's "nearest step first"
  is read that way. Riding events the answer left out go with the step that
  claimed their action; an action no step claimed goes with its events when one
  step claimed them all.
- **An edited step locks nothing, but is a floor.** An ordinary call may not
  reach back past it (as past a step of the author's); a redraft keeps it and
  puts it back among the new steps by where its actions are. Its actions are
  **left out of every call** — the prompt lists the step and their numbers
  instead — so the model cannot describe them again; a step an answer ties to
  nothing but them is not written either. An exact copy of its words is dropped
  only when the answer's mapping does not hold up: with one that does, the same
  words for a repeat of the action are a step of their own (I10).
- **An edit or a delete naming a step the model has since rewritten** replaces
  (or deletes) every step that now stands for any of the actions the named one
  stood for. An edit puts one step there — the author's words, all their
  actions, **under the id the edit named** — so `record:edited.id` is always the
  id that was sent, and TestBench's line keeps its id. An edit to a step whose
  actions no step stands for any more is `ignored`, saying so.
- **Restoring one action of a deleted step** (the panel's ✕ on a struck action)
  redrafts its stretch, and the model writes a step for it; the deleted step
  stays deleted and can no longer come back as it was — Restore answers why —
  even if that action is dropped again later. Its other actions stay struck.
- **A reworded step whose actions are all dropped since stays** where it was,
  in the result too: the author's words are never lost. Deleting it is the ✕.
- **Edits, deletes and restores are carried out the moment they arrive**, not
  queued behind an Add step as the checklist had it: none needs a model call,
  so the control route can answer exactly whether each applied (`ignored` and
  why), and one accepted before Stop is trivially complete before the steps
  are written. A call in flight that could rewrite the changed step is thrown
  away and made again — a redraft of its stretch at once; an ordinary call when
  its answer comes, which now lands by the ids of the steps it replaces, so a
  change before them moves nothing and costs no call.
- **Parameters no step uses leave the draft's list** at every draft, not only
  after a delete — the model is asked for "the whole list the draft uses"
  anyway.
- **`record:draft.edited` lists reworded steps of the model's only.** A step of
  the author's is `authored` already; editing it replaces its text.
- **Frame order.** A step's `record:dropped` (with `actions`) goes out before
  the draft without it, as `record:step` goes before the draft with it. An
  action's or an author step's goes out after, from the toolbar only, as Undo
  always did — unchanged.
- **One addition beyond the wire:** `drop` and `restore` accept an optional
  `source: 'editor' | 'panel'`, echoed in a step's `record:dropped` (`panel`
  when absent). The frame's union names `editor`, and the server cannot know it
  otherwise. Nothing depends on it.
- **The drawer.** Rows are focusable in the bar's own Tab cycle (buttons,
  status row, rows and their ✕ and +), which never leaves for the page; the
  arrows move between rows; Enter or F2 edits; Delete or Backspace removes; Esc
  gives focus back to the page. A struck row stays — for deletes from anywhere,
  Undo of an author's step included — until a draft brings a step that was not
  there since the delete; the bar says `Removed "…"` with Restore for a step's
  delete from any source. An edit in place that loses focus to the page stays
  open when its words changed (a stray click does not throw them away) and
  closes when they did not. The bar's "Added as step 8" no longer says "steps
  1–7 locked".

**A bug the property run found, older than this change.** An author step that
waited for a call which had taken in actions recorded after the step was sent
(a refused answer's retry does) closed the stretch at the step's boundary: the
later actions' coverage moved below the line and was redrafted there, while
the steps already describing them stayed above it — the same action written
twice, on both the "between" and "at the end" paths. The stretch now closes
after every step that starts before the line, and steps drafted over later
actions move below the line as they are, with no redraft. A second one: a
deleted step's Restore checked only that its actions were still dropped, so an
action restored on its own, redrafted, and dropped again let the step back in
beside the new one — now the delete remembers that its actions came back.

Known gaps: the mapping is only as good as the model's answer or the
inference (a step the model tied to the wrong actions deletes the wrong ones —
struck and restorable in the panel); a step of the author's typed inside a
stretch still keeps its index through a redraft, the approximation the toolbar
story noted; none of this was run against a real model yet.

Counts: `npm run build` clean. The record-steps files: 42 engine cases (the
property run among them), 58 in the HTTP suite (8 new), 39 in the toolbar
suite (11 new), 236 across the six record-steps files, all green. Root
`npx vitest run`: 271 files, 6861 tests, all passing. Every new case was run
against the unchanged code first and seen failing: 41 of the 42 engine cases (the other pins Undo's
unchanged drop of an author step), all 8 HTTP cases, all 11 drawer cases, and
the four existing cases whose expectations changed (the prompt's `actions`,
"locked" gone from the bar, the drawer's hint).

## What the TestBench half built

TestBench 0.5.158. Built in `testbench-native/` — the file rules in
`src/extension/record-steps-core.ts`, the recorder in
`src/extension/step-recorder.ts`, the panel in `src/webview/testbench-runner.jsx`
and `src/webview/lib/recording-panel.js` — and the wire in `runner-core`
(`record:draft.ids` / `edited`, `record:edited`, `record:dropped.actions`,
`edit-step`). The wire is as above, with the server half's one addition: a
`drop` or `restore` made in the file carries `source: 'editor'`, one from the
panel `source: 'panel'`.

**Recorded lines keyed to step ids.** Each block part of what the recording
wrote carries the id of the step on each of its lines. The first keystroke
that changes a recorded line's words makes it a line of the author's (a `mine`
slot of `edit` origin) standing for that step: the recording writes the lines
around it and its number, never its words, and a draft holding the step's id
holds the line, so nothing is written beside it. It goes as `edit-step` at the
moments a typed line counts; a draft showing the step `edited` with those
words, or a `record:edited` naming them, is the line. Whole lines deleted —
one, several, recorded and typed together — are a `drop` each as soon as they
are gone, and the step is left out of every draft written from then on, so one
already on its way does not put the line back. Deleting a line the author
typed is its step's `drop` too now (with a server that names its steps).

Decided here, where the story left it open:

1. **A line changed back** to its words before anything was sent is the
   recording's line again, and **its number alone changed** is no edit — the
   next draft gives it its number back.
2. **An emptied line** (or one left a bare number) is a delete: `drop`, and
   the line stays as the author left it, standing for nothing. Cancel takes it
   out while it has no words (it was the recording's line; nothing of the
   author's is lost); words typed on it make a new line of theirs. **Ctrl+Z of
   emptying it** is a Restore: the line stands for its step again.
3. **The model rewriting a step the author is editing** writes its new step
   beside the line, where the old one was, until the edit lands on it (by the
   id `record:edited` names, or by the words the draft shows `edited`); then
   the model's line goes. The author's words are never written twice.
4. **The drawer and the file on one step.** Words from the drawer or the panel
   are put on a line of the author's standing for the step — a reworded
   recorded line, or one they typed — while it still reads as the recording
   last held it: the one time the recording writes words onto a line of
   theirs. Changed since, the file wins: the line keeps what they wrote, it
   goes as their edit when they leave it, and the log says so once, by the
   line's number. An echo of an older edit of a line does not answer its newer
   one, and drawer words that arrive while an edit of theirs is on its way are
   not put on it (the server took them first). Words from the file are never
   put on another line: when two lines come to stand for one step (the author
   reworded both the line the model rewrote and its new one), each keeps its
   own.
5. **A step deleted in the file never takes another line of theirs with it.**
   Only a delete made elsewhere (drawer, panel, Undo) takes out a line that
   reads as the recording last left it, as Undo of a typed step always did.
6. **The recording's own clear-out is named** (`LiveDraft.clear`: Cancel, an
   error, the drafts taken out before the result). A draft of the server's
   with no steps — the author deleted every one — takes out only the
   recording's lines; before, it was treated as Cancel and took the author's
   emptied line out from under their cursor.
7. **An old server** (no `ids`): nothing changes — edits inside the recorded
   lines are written over and warned, typed lines edited after sending are
   not sent, deleting one is not a drop — the log says once why, and Steps so
   far shows no ✕.
8. **The panel** keeps a deleted step struck, with Restore, until it is
   restored — not until the next step lands, as the drawer does: the panel is
   the whole record. `✎ Edited step 4: <words>` rows say where the edit was
   made. A delete or restore from the panel the server does not take puts the
   row back as the recording has it, said in the log. Reworded lines are not
   highlighted in the editor: they are the author's, like the lines they type.

**Undo, measured** (VS Code 1.95, in the host): an undo reports the exact
inverse of the edits it undoes — typing, `editor.action.deleteLines`, a write
of two ranges — never line diffs. So an undo within one line of the author's
is followed by position, as their typing was; others are looked for by text,
now among the states just before each of the author's edits too (a deleted
line's undo finds the state that held it, which restores its step). §7.4 of
the spec has the rules.

**What the random run found.** The 300-seed property run with ids — recorded
lines reworded, renumbered, emptied and deleted, typed lines, Ctrl+Z of
anything (the author's or the recording's, as VS Code's undo stack gives it),
the drawer rewording steps, the model rewriting the step being edited, drafts
lagging, a fake server applying edit-step, drop and restore — failed on each of
these before it was fixed; the last four are pinned by their own cases in
`tests/record-steps-edit.test.js`. A write inserting lines and fixing a number
replaced the whole stretch (lines are now matched by their words, number
aside, and only what differs is written). A run of the author's lines alone
could not be found by its text. An undo within a line of theirs was matched by
an older state that dropped a neighbouring line. An echo of an older edit
acked a newer one. The undo of a deleted line at the run's edge was not seen:
the newest state still fitted (the state that explains more of the file now
wins). A run of blank lines was never unique (it is looked for where the steps
go), and a state holding only renumbered later steps was not kept for an undo.
A step's delete made through another line hid the author's line; a draft with
no steps acted as Cancel; Ctrl+Z of emptying a line made a new typed line with
the recording's words. And one race found by reading: a line emptied while a
write was on its way came back as a reworded line and was dropped twice.

**Tests.** `tests/record-steps-edit.test.js` (32 cases against the core and
the panel helpers) and a second 300-seed property run in
`tests/record-steps-authored.test.js`. Its invariants: a write never replaces
the author's characters, bar a held line's number, a recorded line's number
the author changed, drawer words on a line they have not changed, or the
clear-out's reworded lines; no step's words are in the file twice; the file
is never given up on; Stop leaves the result, each step once, the recording's
in order; Cancel leaves only the author's typed lines. Its last run: 453
edits, 969 drops, 225 restores, 1046 undos, 26 drawer follows, 0 lost. Every
core case failed against the unchanged core first (the harness needs the new
book, so some fail for that alone). Eight host cases in
`tests/integration/suite/record-steps.test.cjs` — reworded by cursor-leave,
deleted and Ctrl+Z, the panel's ✕/Restore, the drawer rewording and deleting
(a reworded line and a typed one), an ignored edit logged by line number,
Stop with a reworded line and the one Ctrl+Z after it, an old server — all
eight run against the unchanged extension and seen failing. runner-core adds
the frame guard and the wire cases.

**Known gaps.** Two lines standing for one step each keep their words, so the
file ends with one line more than the result has. An undo that no state of the
file explains and that is not within one line is still looked for by text only
(and gives up on the file when not found, as before). An edit the server
refused keeps its line standing for its step; if the model later rewrites that
step, its new step goes in beside the line. The halves have not been run
against each other or a real model yet: the fake server in the property run
places steps by id, not by the actions they stand for.
