# Open Last Report Spec

Surface the HTML report that the server already writes after every run so
the user can open it from the Steptix runner panel in one click,
instead of digging through the reports folder.

## 1. Goal

After a run completes (pass or fail), the runner panel shows a button
that opens the run's HTML report in the user's default browser. The
button is enabled iff a report exists for the most recent run of the
currently-active test file.

**Not in scope:**

- Bundling/copying the report into the extension.
- Rendering the report inside VS Code (it's HTML+CSS, meant for browsers).
- Historical browsing of past reports — "Open Last Report" only.
- Auto-opening the report at end-of-run (user controls when to look).

## 2. What already exists

After the SSE stream emits `done`, the server in
[src/server/session-manager.ts:1755-1788](../../../src/server/session-manager.ts#L1755-L1788)
calls `generateReport(report, this.config.reports.outputDir)`, which:

1. Writes an HTML file at `<reports.outputDir>/<timestamp>-<sanitised-test-name>.html`.
2. Logs `Report saved: <absolute-path>` to the server log.
3. Returns the absolute path.

The client never sees this path today — it's swallowed at the server
boundary. The feature is purely a matter of propagating it.

## 3. Wire protocol change

One optional field on `DoneEvent`:

```typescript
// runner-core/src/protocol.ts
export interface DoneEvent {
  type: 'done';
  status: RunStatus;
  /** Absolute path of the HTML report written by the server, when
   *  report generation succeeded. Omitted when generation failed, was
   *  disabled, or the run produced no step results. */
  reportPath?: string;
}
```

Optional — older servers that don't fill it in remain protocol-compatible.
Older clients that don't read it remain compatible with the new server.

## 4. Server behavior

In `executeStepsInternal`, the existing report generation block in
[src/server/session-manager.ts:1755](../../../src/server/session-manager.ts#L1755)
captures the returned path and threads it into the final `emit({ type:
'done', ... })`.

```typescript
let reportPath: string | undefined;
if (fullStepResults.length > 0) {
  try {
    const report: TestReport = { /* ...existing fields... */ };
    reportPath = await generateReport(report, this.config.reports.outputDir);
    logger.info(`Report saved: ${reportPath}`);
  } catch (err) {
    logger.warn(`Failed to generate HTML report for session "${sessionId}": ${String(err)}`);
    // reportPath stays undefined — client will hide the button.
  }
}

// ...frame unwind...

emit({ type: 'done', status: overallStatus, ...(reportPath && { reportPath }) });
```

**When `reportPath` is omitted:**

- The run had zero step results (early abort before any step ran).
- `generateReport` threw (disk full, permission denied, invalid template).
- Report generation was disabled by config (future — not in scope).

In all three cases the client hides the button. No partial states.

## 5. Client behavior

### 5.1 Storage

`RunController` already holds per-document state. Add a single field:

```typescript
private lastReportPath: string | undefined;
```

Set in the SSE event handler when `event.type === 'done' && event.reportPath`.
Read by the host bridge when the webview asks for the current state.

### 5.2 Lifecycle

- **Set** on `done` with a `reportPath`.
- **Not cleared** when a new run starts — the previous report stays
  openable until the new run produces its own. This matches user intent
  ("show me the last report I have for this test"), and avoids a flash
  where the button disappears mid-run.
- **Replaced** when the next `done` event with a `reportPath` arrives.
- **Cleared** never automatically. Persisting across the controller's
  lifetime is enough; we don't restore across VS Code restarts.

### 5.3 Surfacing

The host pushes `lastReportPath` to the webview as part of the
`activeFile` snapshot it already sends. One new field, no new message
type.

### 5.4 Open action

A new command, `steptix.openLastReport`, that:

1. Asks the active `RunController` for its `lastReportPath`.
2. If absent: status-bar message `"Steptix: no report yet — run a test first"`.
3. If the file no longer exists on disk: status-bar message `"Steptix: report file no longer exists at <path>"` (rare — user manually deleted).
4. Otherwise: `vscode.env.openExternal(vscode.Uri.file(reportPath))`.

The command is palette-accessible (`Steptix: Open Last Report`) and
backs the runner-panel button via `hostBridge.postCommand(...)`.

## 6. UX

### 6.1 Button location

Runner panel header row, alongside the existing `Show Run Log` and
`Reveal Resolved .env` actions. Same family — all three open
post-run artifacts.

### 6.2 Button shape

- Label: `Open Report` (verb-noun, matches `Show Run Log`).
- Icon: codicon `$(file)` or `$(preview)`. Pick whichever reads more
  clearly with the surrounding buttons.
- Disabled appearance when no report is available, with tooltip
  `"No report yet — run a test first."`

### 6.3 Enabled-state rules

The button is enabled iff **all** of:

- An active `RunController` exists for the focused test file.
- That controller's `lastReportPath` is set.
- (No live filesystem check on each render — that would re-stat on
  every redraw. The file-exists check happens lazily on click; the
  status-bar fallback in §5.4(3) catches the deleted-by-user case.)

### 6.4 What it doesn't do

- It does not list multiple historical reports. The user opens the
  reports folder themselves for that ("Reveal Reports Folder" is a
  future command, not part of this spec).
- It does not show the report inline in VS Code. Reports use CSS and
  link to screenshots; the user's browser is the right surface.

## 7. Edge cases

| Scenario | Behavior |
|---|---|
| Run aborts mid-step | Server still finalizes the run path and writes a report when `fullStepResults.length > 0`. `reportPath` flows through. |
| `generateReport` throws | `reportPath` stays undefined. Button stays disabled. Server logs the failure as today. |
| User pauses at a breakpoint and never resumes | No `done` event yet → `lastReportPath` stays at the previous value (or undefined). Button reflects the last *completed* run, not the paused one. |
| Multiple sequential runs without server restart | Each `done` overwrites `lastReportPath`. Button always reflects the most recent run. |
| Restart of steptix-vscode (VS Code reload) | `lastReportPath` resets to undefined. User must run once before the button activates. Acceptable — across-restart memory is more state than the feature warrants. |
| Report path becomes stale (file deleted by user) | `openExternal` would fail silently. The pre-check in §5.4(3) catches this and emits the status-bar message. |
| Concurrent runs in two open test files | Each `RunController` has its own `lastReportPath`. The button reflects whichever file is currently focused. |

## 8. Acceptance criteria

1. After a successful run, the button is enabled and clicking it opens
   the report in the system browser.
2. After a failed run, same — the report is still generated for failed
   runs, so the button is still enabled.
3. Before any run for the current file, the button is disabled with
   the no-report tooltip.
4. Editing the test file does not change the button state — the report
   path stands until the next `done` event replaces it.
5. Older server emits no `reportPath` → button stays disabled, no
   protocol errors. (Forward compatibility.)
6. Newer server with older client (no field read) → no errors.
   (Backward compatibility.)

## 9. Implementation plan

**Server / protocol** (3 files):

1. `runner-core/src/protocol.ts` — add `reportPath?: string` to `DoneEvent`.
2. `src/server/session-manager.ts` — capture `generateReport`'s return value and pass it to the final `emit`.
3. `tests/api-server.test.ts` (or `api-server-stepmode.test.ts`) — verify the SSE `done` event carries a `reportPath` when a report writes successfully, and omits it when the run produced zero steps.

**Extension** (4 files):

4. `steptix-vscode/src/extension/run-controller.ts` — store `lastReportPath`; expose via accessor.
5. `steptix-vscode/src/extension/extension.ts` or `commands/index.ts` — register `steptix.openLastReport`.
6. `steptix-vscode/package.json` — declare the command; add the runner-panel button entry.
7. `steptix-vscode/src/webview/steptix-runner.jsx` — read `lastReportPath` from the host snapshot, render the button, post the command on click.

**Tests**:

8. Unit test for the run-controller field updating on `done` events with and without `reportPath`.
9. Integration test (mocha + @vscode/test-electron) that activates the extension, drives a run via the FakeApiClient with a scripted `done` event carrying a `reportPath`, asserts the command is enabled and resolves to that path.

Total: ~150 lines of code + ~80 lines of tests. Low risk — additive
field, additive command, additive button.

## 10. Out of scope

- Server-side persistence of "all reports for this test" — the reports
  folder is the existing source of truth.
- Auto-opening the report at end-of-run.
- A history dropdown / picker in the runner panel.
- Surfacing report metadata (timestamp, status) in the button text.
- Cross-session memory (button persisting across VS Code restarts).

Each of these is a coherent follow-up that doesn't need to land with v1.
