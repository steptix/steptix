# Steptix UI Behavior Spec

## Editor

- The test script is edited in a Monaco Editor instance.
- Each line in the editor represents one runnable test step.
- Blank lines are allowed.
- Blank lines are skipped during execution and marked as skipped.
- The editor supports normal continuous text selection.
- The editor supports non-contiguous line selection using Monaco multi-cursor/multi-selection behavior.
- The app must not use a native textarea for the test script editor.

## Line Selection

- Clicking in the editor selects the clicked line as the active line.
- While drag-selecting text across multiple lines, the gutter line numbers for all touched lines highlight live during the drag, not only after mouse up.
- Selecting a continuous range of text across multiple lines marks all touched lines as selected.
- Pressing Alt and clicking a line adds or removes that line from the selected line set.
- Alt-click selection supports non-contiguous lines, for example selecting lines 2, 5, and 7 at the same time.
- Clicking a line number in the gutter selects the whole line text.
- Alt-clicking a line number in the gutter adds or removes that whole line from the non-contiguous selection set.
- Alt-clicking a line number must select only that one line — clicking line N must never visually highlight line N+1, even though Monaco internally represents "select whole line N" as a selection ending at line N+1, column 1.
- The set of "selected lines" derived from Monaco selections must treat a column-1 endpoint as a line boundary, not as a position belonging to that line.
- Alt-clicking the very last line in the editor must work the same as any other line — it must toggle that line in the selection set even though Monaco's last-line selection cannot extend to a column-1 boundary on a non-existent next line.
- The Alt+Click toggle must be computed from the app's own selected-line state, not from Monaco's transient selections, because Monaco's default mousedown handler may run before the app's listener and pre-insert its own selection.
- Selected gutter line numbers must stay visibly highlighted.
- Selected gutter line highlighting must update immediately on mouse down.
- Running or status icons must not replace or hide line numbers.
- Moving the cursor around in the editor (clicking inside line text, arrow keys, etc.) must NOT mark the line as a "selected line" — the whole-line selection background and gutter highlight should not appear from a bare cursor.
- The "selected lines" set is only populated by: explicit gutter line-number clicks (including Alt+Click multi-select), real text selections that span content (non-empty range or multi-cursor), and the running line during execution.
- When the editor first loads, the cursor is placed at line 1 column 1 with no whole-line selection or gutter highlight.
- Pressing Reset returns the editor to "cursor at line 1 column 1, no selected-line highlight."

## Gutter

- The gutter has enough space for:
  - breakpoint marker
  - line number
  - run status icon
- The gutter visual order is:
  - breakpoint/debug marker on the left
  - line number in the middle
  - run status icon on the right
- The run status icon must be visually separated from the breakpoint/debug marker.
- The gutter should use a compact, reasonable width.
- The breakpoint lane must be wide enough to show the hover outline and solid breakpoint symbol, but must not create excessive empty space to the left of line numbers.
- The line number should sit close enough to the breakpoint lane that the gutter feels compact, while still leaving clear separation.
- The line-decorations lane (between line numbers and the editor text) must be sized to fit the status icon without leaving excessive empty space before the text content.
- Line numbers are always visible.
- Status icons appear separately from line numbers.
- Breakpoints appear to the left of line numbers.
- Run status icons appear to the right of line numbers.
- The far-left gutter lane is reserved for breakpoints.
- The selected-line gutter highlight must look visually balanced — the background does not extend much further to the left of the digit than to the right, even though Monaco right-aligns line numbers and the line-decorations icons sit to the right of the gutter.
- Hovering over an empty breakpoint slot shows an outline of the red breakpoint symbol.
- The hover outline communicates that a breakpoint can be placed there.
- Clicking an empty breakpoint slot places a solid red breakpoint symbol.
- Clicking an existing breakpoint symbol removes it.
- Clicking the breakpoint area toggles a breakpoint for that line.
- Right-clicking the gutter opens a custom context menu.
- The gutter context menu contains `Add Breakpoint` when the line has no breakpoint.
- The gutter context menu contains `Remove Breakpoint` when the line already has a breakpoint.
- Choosing the breakpoint item toggles the breakpoint for that line.
- The gutter context menu also contains a run item: `Run Test Step` (singular) when 0 or 1 lines are selected, and `Run Test Steps` (plural) when 2 or more lines are selected.
- The plural label is driven by the count of selected lines, regardless of whether the selection is contiguous or non-contiguous.
- The run item is disabled while a run is already in progress.
- Choosing the run item closes the menu and starts execution.
- When the singular run item is chosen, only the right-clicked line runs.
- When the plural run item is chosen, only the selected lines run, in ascending line-number order. Non-contiguous selections execute exactly the selected lines and skip the lines between them.
- Right-clicking the gutter must NOT collapse an existing multi-line selection. The pre-right-click selections are snapshotted during the capture-phase mousedown event and restored after the context menu opens.
- The list of items shown in the gutter context menu is produced by a pure helper (`gutter-menu.js`) so that the contract — which items are present, which label they show, which are disabled — can be unit-tested without rendering React.
- The two pure decisions for right-click selection preservation (whether to snapshot, whether to restore) live in `gutter-rightclick.js` so they can be unit-tested.
- The context menu closes when clicking elsewhere.
- The context menu closes when pressing Esc.

## Running Steps

- Pressing F5 runs the currently selected target.
- Clicking the small `F5` button above the editor also runs the currently selected target.
- Clicking the header run button also runs the currently selected target.
- If text or lines are selected, running executes all selected lines.
- If non-contiguous lines are selected, running executes exactly those selected lines in ascending line-number order.
- If no text or line selection exists, running starts from the cursor line and continues downward.
- When a single line is selected, running executes only that selected line.
- When multiple continuous lines are selected, running executes all selected lines.
- When multiple non-contiguous lines are selected, running executes all selected lines.
- The selected text/line selection should remain selected after pressing the small `F5` button.
- The selected text/line selection should remain selected while running selected lines.
- During execution, the active line should be tracked separately from selected lines.
- A running line shows a running status icon.
- A passed line shows a pass status icon.
- A failed line shows a fail status icon.
- A skipped blank line shows a skipped status icon.
- Failure details are shown below the editor for the selected failed line.

## Breakpoints

- When running from a line downward, execution stops before a later breakpoint.
- When execution stops at a breakpoint, the output log records that it stopped at that line.
- Breakpoints do not remove or hide line numbers.
- Breakpoints can coexist with status icons.

## Instruction Pointer

- When a run halts at a breakpoint, a yellow ▶ instruction-pointer arrow is rendered in the line-decorations lane on the stopped line.
- The arrow indicates the line that will execute next when the run is resumed.
- The arrow is cleared when a new run starts.
- The arrow is cleared by Reset.
- The arrow is draggable while a run is paused at a breakpoint.
- Dragging the arrow uses a `grab` / `grabbing` cursor.
- While dragging, the arrow follows the cursor and snaps to the line under the pointer.
- Releasing the drag commits the new line as the next line to execute, so the next Run resumes from that line.
- The arrow takes visual precedence over the run status icon: while the arrow is on a line, that line's status icon is hidden.
- Moving the arrow off a line restores any status icon (pass / fail / skipped / running) that line previously had — the underlying status state is not modified by dragging.
- The arrow cannot be dragged outside the valid line range.
- The arrow is not draggable while a run is actively executing.
- Hovering the arrow shows a tooltip indicating it is the next line to execute and that it can be dragged to move.

## Line Tracking Across Edits

- Breakpoints, run status icons (running / pass / fail / skipped), error panel association, and the instruction-pointer arrow are anchored to line content, not to fixed line numbers.
- Inserting a new line above an anchored line must shift the anchor down by the number of lines inserted.
- Deleting lines above an anchored line must shift the anchor up by the number of lines removed.
- Pressing Enter mid-line keeps the anchor on the line whose original prefix remains (the upper line of the split).
- Pressing Enter at column 1 of a line shifts that line's anchor down with the original content.
- Selecting a span of lines and replacing it removes anchors whose lines were fully consumed and shifts anchors below the span by the net line-count delta.
- Anchors whose underlying line is fully deleted are removed.
- Anchors are never left pointing past the end of the document.
- Backspacing at column 1 of a line (merging it into the line above) collapses that lower line's anchor onto the surviving upper line.

## Code Quality

- Pure logic for line-number derivation, Alt+Click selection toggling, and edit-driven line remapping must live in dedicated modules (`selection-lines.js`, `line-tracking.js`) so it can be unit-tested without React or Monaco.
- The unit test suite (`npm.cmd test`) covers the Alt+Click selection rules and the line-tracking remap rules, including regression cases for the column-1 boundary bug.

## Run Controls

- The header has a Pause/Resume button.
- The header has a Stop button.
- Pause is enabled only while running.
- Stop is enabled only while running.
- Pressing Pause pauses execution between simulated execution ticks.
- Pressing Resume continues execution.
- Pressing Stop cancels execution cleanly.
- Stopping a run resets the currently running line back to idle.
- Pause, resume, and stop events are written to the output log.

## Output Log

- The output log appears in the right panel.
- The right output panel is resizable by dragging the divider between editor and log.
- The output panel can expand much wider than its default width.
- The output panel must leave at least a small usable editor area visible.
- The log starts empty with an empty-state message.
- Each run event appends to the log.
- Failed log entries are visually distinct.
- Output log entries always wrap, regardless of the `editor.wordWrap` setting — the setting only affects the Monaco script editor.
- Long unbroken strings (URLs, paths) in the output log must wrap rather than overflow horizontally.

## Toolbar

- The strip immediately above the Monaco editor is the toolbar.
- The toolbar contains only the inline `F5` run button.
- The toolbar element exposes `data-testid="toolbar"` and `role="toolbar"` so tests can locate it without depending on text content.

## Settings

- App-level user settings live in `app-settings.json` at the project root.
- The settings JSON is imported at build/load time; changing it requires the editor (page) to reload before the new value takes effect.
- `editor.wordWrap` is a boolean controlling Monaco's word wrap. Default is `true`.
- When `editor.wordWrap` is true, long lines wrap visually inside the Monaco editor.
- When `editor.wordWrap` is false, long lines extend horizontally with a horizontal scrollbar.

## Editor / Output Splitter

- The splitter between the editor and the output log is rendered as a single thin vertical line at rest, not a double line.
- The splitter has a wider invisible hit area so it remains easy to grab even though only a 1px line is visible.
- Hovering over the splitter fills the full hit-area width with the border color to indicate it is draggable.
- While the user is actively dragging the splitter, it is highlighted in the active blue color.
- The splitter cursor is `col-resize`.

## Themes

- The app supports dark mode.
- The app supports light mode.
- The default theme on first load is light mode.
- The header contains a light/dark theme toggle.
- Theme changes apply to:
  - page background
  - header
  - editor
  - gutter
  - line selection highlight
  - output panel
  - context menu
  - toolbar
  - resize divider

## Browser Runtime

- The app runs in the browser from the local Vite dev server.
- The app does not depend on CDN scripts at runtime.
- Dependencies are installed locally through npm.
- The app can be started with `npm.cmd run dev -- --port 5173`.
- The app can be production-built with `npm.cmd run build`.

## Regression Checks

- Build check: `npm.cmd run build` must succeed.
- Manual check: opening `http://127.0.0.1:5173/` shows the app and Monaco editor.
- Manual check: selecting lines 2 and 5 with Alt-click highlights both line numbers.
- Manual check: pressing F5 with lines 2 and 5 selected runs only lines 2 and 5.
- Manual check: clicking a line number selects the whole line text.
- Manual check: dragging across lines highlights gutter line numbers while dragging.
- Manual check: breakpoints can be added by gutter click and by right-click context menu.
- Manual check: pause, resume, and stop work during a run.
- Manual check: the output panel can be resized wider than half the window.
- Manual check: hitting a breakpoint shows a yellow ▶ arrow in the line-decorations lane on the stopped line.
- Manual check: the yellow ▶ arrow can be dragged to another line, and releasing sets that line as the next to execute.
- Manual check: dragging the arrow over a line that already has a status icon hides the status icon for that line; moving the arrow off restores the original status icon.
- Manual check: starting a new run or pressing Reset clears the yellow ▶ arrow.
- Manual check: the line-decorations lane width is compact and does not leave excessive empty space before the text content.
- Manual check: the editor / output-log splitter shows as a single thin vertical line at rest, fills with the border color on hover, and turns blue while dragging.
- Manual check: Alt-clicking a single line number in the gutter highlights only that line in the gutter — the line below must not also be highlighted.
- Manual check: with a breakpoint on line 2, pressing Enter on line 1 moves the breakpoint to line 3.
- Manual check: with a pass/fail status on line 2, pressing Enter on line 1 moves the status icon to line 3.
- Manual check: with the ▶ instruction pointer on a line, inserting lines above it shifts the arrow down with its line.
- Manual check: deleting a line that has a breakpoint or status icon removes that breakpoint/status.
- Automated check: `npm.cmd test` runs the unit suite (`selection-lines.test.js`, `line-tracking.test.js`) and all tests pass.
- Manual check: Alt-clicking the very last line in the editor adds it to the selection; Alt-clicking it again removes it.
- Manual check: right-clicking a gutter line number with no other lines selected shows a `Run Test Step` item; choosing it runs only that line.
- Manual check: with two or more lines selected, right-clicking a gutter line number shows `Run Test Steps` (plural); choosing it runs the selected lines in ascending order.
- Manual check: with non-contiguous lines selected (e.g., 2, 5, 7), `Run Test Steps` executes exactly those lines and does not run the lines between them.
- Manual check: right-clicking the gutter while a multi-line selection exists does NOT clear that selection.
- Manual check: the run item is disabled while a run is already in progress.
- Automated check: `tests/gutter-menu.test.js` asserts that the menu shows the correct singular/plural label, includes both `Add Breakpoint`/`Remove Breakpoint` and the run item, and respects the running-disabled state.
- Automated check: `tests/gutter-rightclick.test.js` covers the right-click selection-preservation helpers (`shouldSnapshotSelection`, `getSelectionsToRestore`).
- Manual check: when the page first loads, the editor shows a bare cursor at line 1 with no whole-line highlight.
- Manual check: clicking inside the text of any line moves the cursor without painting that line's whole-line selection background.
- Manual check: arrow-key cursor movement does not paint the cursor's line as selected.
- Manual check: with `editor.wordWrap` set to `true` in `app-settings.json`, long script lines wrap inside the Monaco editor.
- Manual check: with `editor.wordWrap` set to `false`, long script lines do not wrap and a horizontal scrollbar appears.
- Manual check: the output log always wraps long entries regardless of the `editor.wordWrap` setting.
- Manual check: clicking a gutter line number still highlights the whole line as before.
- Manual check: drag-selecting text across multiple lines still highlights the touched lines as before.
