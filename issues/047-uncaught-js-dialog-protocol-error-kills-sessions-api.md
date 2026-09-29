# 047 — Uncaught Playwright `Page.handleJavaScriptDialog` crash kills the Sessions API mid-run

**Status:** fixed — root cause is an unguarded promise inside `playwright-core`; see [Resolution](#resolution)  
**Severity:** high — whole process exit; all sessions lost; MCP clients see `streamDropped: true`  
**Area:** Sessions API process lifetime / Playwright page lifecycle. Likely surface is whatever installs or races dialog handling around CDP-attached pages (Playwright internal `DialogManager` + our lack of a process-level guard). Start from:

- [src/browser/manager.ts](../src/browser/manager.ts) (page attach / `page.on` hooks)
- [src/server/session-manager.ts](../src/server/session-manager.ts) (run loop; no try/catch around process-killing errors)
- [src/mcp/api-client.ts](../src/mcp/api-client.ts) (`streamDropped` when SSE ends without `done`)
- [src/mcp/run-fold.ts](../src/mcp/run-fold.ts) (warning text for dropped streams)

**Opened:** 2026-08-09  
**Reported from:** live Agent Fleet / MCP session driving OpenRouter Credits purchase on a persistent Chrome CDP profile. Investigation used `.steptix/mcp-server.log` + tool results from that session.

---

## Symptom (what the agent / user saw)

1. MCP `run_steps` mid-click returned:
   - `status: "error"`
   - `streamDropped: true`
   - warning: *"The connection to the server ended without a completion event. The run may still be executing there; call get_last_run to check."*
   - step status stuck / incomplete (`unknown` / no clean terminal)
2. Immediate follow-ups failed: `get_page_content` / `list_sessions` → **fetch failed**; later `run_steps` → **Request timed out**.
3. `server_status` then showed a **brand-new** process:
   - `baseUrl: http://localhost:3100`
   - `startedAt: 2026-08-09T03:32:49.939Z` (seconds after the crash)
   - `openSessions: 1` (not the previous CDP-backed session state)
4. Persistent Chrome CDP browser **stayed open** (profile `default`, port `16839`). Only the Node Sessions API died.
5. After restart, a recreate of the same session id **launched a fresh headed Chromium** instead of reattaching CDP (config only applied on session create; the auto-recreate path did not carry `config.cdp`). That made recovery worse and risked acting in the wrong browser.

The stream-drop warning’s “run may still be executing” branch is **misleading for this failure mode**: the server process was gone.

---

## Root cause (from log — definitive)

The Sessions API process **crashed with an uncaught exception** while retrying a click on OpenRouter’s Purchase Credits UI.

### Exact crash (verbatim from `.steptix/mcp-server.log`)

```text
[2026-08-09 03:32:07] Step 4/4: Click the Purchase button to complete the $5 credit purchase
  → Click the Purchase button to complete the $5 credit purchase
[2026-08-09 03:32:20] [ERROR] Action failed [click]: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('[role="dialog"] button:text-is("Purchase")').filter({ visible: true }).first()

[2026-08-09 03:32:21] [WARN]  step 1 failed on attempt 1: StepFailureError: locator.click: Timeout 10000ms exceeded.
...
[2026-08-09 03:32:21] [INFO]  Retrying step 1 (attempt 2/2)...
  → Click the Purchase button to complete the $5 credit purchase
[2026-08-09 03:32:25] [INFO]  Turn 1 complete (needs_reeval=true) — starting turn 2
node:internal/process/promises:394
    triggerUncaughtException(err, true /* fromPromise */);
    ^

ProtocolError: Protocol error (Page.handleJavaScriptDialog): No dialog is showing
    at C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\chromium\crConnection.js:111:57
    at new Promise (<anonymous>)
    at CRSession.send (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\chromium\crConnection.js:110:12)
    at Dialog._onHandle (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\chromium\crPage.js:669:28)
    at Dialog.dismiss (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\dialog.js:59:16)
    at Dialog.close (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\dialog.js:65:18)
    at DialogManager.dialogDidOpen (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\dialog.js:85:14)
    at FrameSession._onDialog (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\chromium\crPage.js:662:45)
    at CRSession.<anonymous> (C:\Projects\vibe\ai-ui-automation\node_modules\playwright-core\lib\server\chromium\crPage.js:343:119)
    at CRSession.emit (node:events:519:28) {
  type: 'error',
  method: 'Page.handleJavaScriptDialog',
  logs: undefined
}

Node.js v22.22.0
```

Then the process came back (auto-start / MCP ensure-server path):

```text
Debugger listening on ws://127.0.0.1:65128/...
[2026-08-09 03:32:49] [INFO]  Sessions API server listening on http://127.0.0.1:3100
[2026-08-09 03:32:49] [INFO]  Idle timeout armed: 60m with no run in flight and no authenticated request
[2026-08-09 03:32:49] [INFO]  Server ready — press Ctrl+C to stop
```

### Interpretation

1. **First failure was ordinary:** Playwright could not click `[role="dialog"] button:text-is("Purchase")` within 10s (ARIA `role="dialog"` Purchase Credits modal was present in a screenshot earlier; locator race / overlay / Stripe iframe / disabled button are all plausible — secondary issue).
2. **On retry, Playwright’s internal dialog manager** received a Chromium dialog event and tried to `dismiss` via CDP `Page.handleJavaScriptDialog`.
3. Chromium answered **“No dialog is showing”** → `ProtocolError`.
4. That rejection was **not caught** anywhere in our process → Node `triggerUncaughtException` → **process exit**.
5. MCP SSE reader saw the socket end without a `done` event → `streamDropped: true` ([api-client.ts](../src/mcp/api-client.ts) around the `sawDone` / `streamDropped: !sawDone` return).

This is **not** idle timeout (60m). The server was actively running a step.  
This is **not** the user closing Chrome. CDP profile/browser survived.

There is **no** `page.on('dialog', …)` handler in our `src/browser` or `src/server` code (grep is empty for that). The stack is entirely inside `playwright-core`’s default `DialogManager.dialogDidOpen` → `Dialog.dismiss` path. So either:

- Playwright’s default auto-dismiss raced a dialog that closed itself, or
- a page (OpenRouter / payment iframe / extension) emitted a dialog event that was already gone by handle time, or
- CDP multi-session / attach quirks double-delivered a dialog event.

Any of those should be a **step/run failure**, not a process death.

---

## How MCP maps this (expected, once server dies)

```247:250:src/mcp/api-client.ts
      // A stream that ends without `done` means the server went away
      // mid-run — killed, force-stopped, or reaped. The run may still be
      // executing over there, which is why this is not simply a failure.
      return { events, receivedAt, streamDropped: !sawDone, dropped };
```

```392:396:src/mcp/run-fold.ts
  if (streamDropped) {
    warnings.push(
      'The connection to the server ended without a completion event. The run ' +
        'may still be executing there; call get_last_run to check.',
    );
  }
```

For a **process crash**, “may still be executing” is false. A better signal would distinguish client abort vs server death vs clean incomplete stream (optional improvement; not required to fix the crash).

---

## Timeline (local log times, Windows machine)

| Time (log) | Event |
|---|---|
| 03:30:31 | Session `mcp:openrouter-credits-20260809` created; CDP attach port 16839 to OpenRouter Workspaces tab |
| 03:30:40 | Navigated to Credits; balance **$35.19** |
| 03:31:50–03:31:59 | Add Credits + amount **5**; Purchase dialog open (screenshot confirmed VISA ••••2409, amount 5) |
| 03:32:07 | Step: click Purchase |
| 03:32:20 | Click timeout on `[role="dialog"] button:text-is("Purchase")` |
| 03:32:21 | Retry attempt 2/2 |
| 03:32:25 | Turn 1 complete → turn 2; **uncaught ProtocolError**; process exits |
| 03:32:49 | Server listening again on :3100 |
| 03:32:50 | Same session id recreated → **Launching chromium browser (headed)** (NOT CDP) |
| 03:33:48 | That run aborted by client |
| 03:34:02 | New session `mcp:or-buy-5` CDP-attached to Credits tab again |
| 03:34:03–03:34:16 | Branched purchase step started; aborted mid-model-turn (`Request was aborted`) |

**Credits page after the mess (read-only check):** total available **$34.97**; Recent Transactions showed **Aug 9, 2026, 1:32 PM — $5.00**. So a $5 top-up did land once (user and/or one of the attempts). Balance drop vs earlier $35.19 is consistent with usage + one top-up, not necessarily a double charge — still, **retrying purchase after a stream drop was unsafe agent behavior** and should be called out in recovery guidance.

---

## Environment / context for reproduction

- **OS:** Windows  
- **Node:** v22.22.0 (from crash dump)  
- **Project:** `C:\Projects\vibe\ai-ui-automation`  
- **Server log:** `.steptix/mcp-server.log` (full crash + restart present; file was ~546 KB at investigation time)  
- **Browser:** project-owned CDP Chrome profile `default`, port **16839**  
  - profileDir: `.steptix/cdp-profiles/chrome-default`  
- **Tab:** `https://openrouter.ai/settings/credits`  
  - targetId at the time: `47A50C5437DE1711BD34B9356C835DAB`  
- **Session:** `mcp:openrouter-credits-20260809`  
- **UI state:** native OpenRouter “Purchase Credits” modal (`role="dialog"`), amount 5, saved card VISA ending 2409  
- **Playwright:** dependency via project `package.json` (`playwright` ^1.59.x at time of write — confirm lockfile when fixing)  
- **Model driving steps:** `aibroker/openrouter/openai/gpt-5.6-luna` (from tool `effectiveSettings`)

### Related HTML report / run logs (may still be on disk)

- `reports/2026-08-09_03-31-59-steptix-mcp-steps.html` — successful Add Credits + amount 5  
- `reports/2026-08-09_03-33-48-steptix-mcp-steps.html` — post-restart aborted run  
- `reports/2026-08-09_03-34-16-steptix-mcp-steps.html` — `mcp:or-buy-5` aborted  
- `reports/logs/C__Projects_vibe_ai-ui-automation_.steptix-mcp-steps.md-2026-08-09T03-32-07-298Z.log` — run log covering the crashing step (if retained)

---

## Follow-on failure (secondary, same incident)

After crash recovery at 03:32:50:

```text
[INFO] Creating session "mcp:openrouter-credits-20260809"
[INFO] Launching chromium browser (headed)
```

The MCP client reused the **same session id** without re-supplying `config.cdp`, so the new server created a **disposable headed browser** instead of attaching to the still-running CDP Chrome. That is by design today (config only on create) but is a sharp edge when:

1. Server dies mid-run  
2. Client retries with the old session id  
3. Auto-start brings the server back empty  

Fixing the crash is primary. Hardening recovery (refuse to recreate a session id that previously had CDP without explicit config; or persist session browser binding) is secondary and can be a separate issue if not fixed here.

---

## What is *not* the bug

| Candidate | Why ruled out |
|---|---|
| Idle timeout (60m) | Crash during active step; uptime seconds, not hours |
| MCP deliberately aborting | First death is uncaught exception in server process; client abort appears later as “run aborted by client” |
| User closed CDP browser | `list_cdp_browsers` still showed Chrome default + Credits tab after |
| Ordinary step failure | Click timeout was logged as ERROR/WARN and would have been a normal failed run; the process exit is separate |
| SSE parser bug | Server PID died; `startedAt` jumped |

---

## Proposed fix directions (for the implementing agent)

### Must-fix (process must not die)

1. **Catch unhandled rejections / uncaught exceptions** in the Sessions API entrypoint and log + keep serving (or at least finalize in-flight runs and exit cleanly). A dialog protocol error must never take down all sessions.
2. **Install an explicit `page.on('dialog', …)` handler** on every Page we own (launch + CDP attach) that:
   - accepts/dismisses with try/catch around `dialog.accept()` / `dialog.dismiss()`,
   - logs type + message,
   - never lets a rejected handle become an unhandled rejection.
3. Optionally **disable or override** Playwright’s default DialogManager behavior if we still see races after (1)+(2) — check current Playwright version behavior for auto-dismiss.

### Should-fix (observability / client truth)

4. When the server is about to die or has restarted, MCP `streamDropped` warning should not claim the run “may still be executing” if health `startedAt` is newer than the run start (or if TCP reset / ECONNRESET).
5. On session recreate after server restart, do **not** silently launch a disposable browser when the client intended CDP — require `config.cdp` or fail closed with a clear error.

### Nice-to-have (the original click)

6. Investigate why `button:text-is("Purchase")` inside `[role="dialog"]` timed out while the modal was visible (iframe? disabled until tax/address resolved? animation?). Separate from the crash but triggered the retry path.

### Tests

- Unit/integration: fire a page `alert()` that closes immediately / double-fire dialog events during a step; assert server process stays up and the run ends `failed` or `passed`, not process exit.
- Optionally mock CDP `Page.javascriptDialogOpening` without a matching dialog and assert no unhandled rejection.
- Regression: crash log stack path (`DialogManager.dialogDidOpen` → `dismiss` → `ProtocolError`) must not kill `serve`.

---

## Suggested investigation order for the next agent

1. Confirm crash still present in `.steptix/mcp-server.log` (search `handleJavaScriptDialog` / `No dialog is showing`).  
2. Find Sessions API bootstrap (`serve` / server listen) and whether any `process.on('uncaughtException'|'unhandledRejection')` exists — today the log shows bare Node default.  
3. Trace CDP attach path: where `page` objects are created after `Connecting to Chrome over CDP` and add dialog handler + tests.  
4. Reproduce with a minimal HTML page that calls `alert()` in a racy way under CDP attach (more reliable than OpenRouter payment UI).  
5. Only then consider OpenRouter-specific click locator flakiness.

---

## Acceptance criteria

- [x] A Playwright `ProtocolError` on `Page.handleJavaScriptDialog` during a run **does not** exit the Node process.  
- [x] The run fails or recovers at step granularity; MCP receives a normal terminal `done` (or a controlled error), not a naked dropped stream from process death. *(Better than that in practice: the dialog is answered and the run simply continues.)*  
- [x] Automated test covers dialog race / missing dialog handle.  
- [ ] (Optional) Post-restart session recreate does not launch disposable Chromium when the prior intent was CDP without explicit config. **Not done** — see [Still open](#still-open).

---

## Resolution

### The bug is one missing `.catch()`, and it is upstream

`playwright-core/lib/server/dialog.js`, `DialogManager.dialogDidOpen` — line 85, exactly where the production stack points:

```js
let hasHandlers = false;
for (const handler of this._dialogHandlers) {
  if (handler(dialog)) hasHandlers = true;
}
if (!hasHandlers)
  dialog.close().then(() => {          // <-- no .catch()
  });
```

Ten lines below, `removeDialogHandler` makes the identical call as
`dialog.close().catch(() => {})`. Same file, same object, one guarded and one
not — an oversight, not a design decision.

`hasHandlers` was false for us because nothing in `src/` subscribed to
Playwright's `dialog` event; the handler that would set it
(`browserContextDispatcher.js:113`) returns `false` unless someone is listening.
So **every** JS dialog in **every** run took the unguarded branch, and any
failure of that one CDP round-trip became an uncaught exception.

**Upgrading does not fix this.** Verified against `playwright-core@1.62.1`
(latest stable at the time of writing; the project is on 1.59.1) — still
`dialog._close().then(() => {})`, with `removeDialogHandler` still using
`.catch()`.

The three hypotheses listed under *Interpretation* above are therefore all
beside the point: whichever one cancelled the dialog, the process death was
guaranteed by the missing guard, not by the cancellation.

### Reproduction

A cross-origin iframe raises the dialog and the parent — a separate renderer, so
not blocked by the modal — tears the iframe out from under it. Chromium cancels
the dialog inside Playwright's in-flight handle. The stack comes back
frame-for-frame identical to the production one (same nine frames, same line
numbers); only the protocol message differs (`Internal server error, session
closed.` vs `No dialog is showing`), which is just *how* the dialog went away.
Under Node's defaults the process exits with code 1.

This shape is a good match for the incident, whose page hosted a Stripe payment
iframe. It is not proof of which cancellation actually occurred there, and that
remains unidentified — it is also no longer load-bearing.

### The fix

1. **`installDialogGuard(context)`** in [src/browser/manager.ts](../src/browser/manager.ts)
   subscribes to `context.on('dialog')` and answers every dialog itself, with
   the handle call `.catch()`-guarded. Subscribing retires Playwright's
   unguarded branch entirely; the fallback we inherit instead
   (`client/browserContext.js:124`) is already guarded.
   - **On the context, not the page.** `DialogManager` is context-wide, so under
     CDP the blast radius includes the user's own tabs — the ones `PageTracker`
     deliberately ignores. A per-page subscription would have left those able to
     kill the server.
   - Disposition mirrors Playwright's default exactly (accept `beforeunload`,
     dismiss the rest), so run behaviour is unchanged. Dismissing a
     `beforeunload` would silently cancel the navigation a step just asked for.
   - Wired into both context-creation paths in `launchBrowser` — the launch path
     and the CDP attach path — before any page exists.
2. **Every dialog is now logged** (type, disposition, page, message). Until now
   Playwright dismissed them all in silence: a run could be derailed by an alert
   with nothing in the log afterwards to say so. This closes an observability
   gap that predates the crash, and is worth re-reading the incident with — a
   modal JS dialog blocks the renderer, which is what a `locator.click` waiting
   on visibility would time out against (see *nice-to-have* #6).
3. **`installCrashGuards()`** in [src/server/api-server.ts](../src/server/api-server.ts)
   is the backstop for the next one: `unhandledRejection` and
   `uncaughtException` are logged with their stacks and the server keeps
   serving. Armed from inside the `app.listen` callback, deliberately — a failed
   bind (EADDRINUSE above all) surfaces as an uncaught exception and
   `mcp/server-start.ts` depends on that staying fatal, so a second server
   spawned onto a taken port still dies there instead of lingering.

### Tests

[tests/dialog-guard.test.ts](../tests/dialog-guard.test.ts) and
[tests/server-crash-guards.test.ts](../tests/server-crash-guards.test.ts) — 17
tests over three layers: disposition and the catch against fakes; the real crash
race against a real browser; and the wiring on both `launchBrowser` paths
(including a real CDP-attached browser, which needed a new fixture — no existing
test spun one up).

Two things worth knowing about them:

- The real-browser tests count dialogs from the **guard's own log line**, not
  from a second `context.on('dialog')` observer. Subscribing in the test would
  itself flip `hasHandlers` to true — the very condition under test — and the
  test would then pass with the fix deleted.
- Mutation-checked: with `installDialogGuard` stubbed to a no-op, all 13 tests
  in `dialog-guard.test.ts` fail, the three real-browser ones included.

Full suite green afterwards (112 files / 2127 tests), and the acceptance
scenario re-run against the built `dist/` under Node's default fatal
unhandled-rejection behaviour survives.

### Still open

- **Follow-on failure #5** (recreate after restart launching a disposable
  browser) is untouched. Note that a warning for it already exists — "W2" at
  [src/mcp/tools.ts](../src/mcp/tools.ts) — and *would* have fired in this
  incident. But it is post-hoc: the run has already executed in the fresh
  signed-out browser by the time an agent reads it, which for a purchase flow is
  the wrong strength. That supports the fail-closed proposal rather than being
  covered by what is there.
- **Should-fix #4** (`streamDropped` claiming the run "may still be executing"
  when the server actually died) is untouched.
- **Nice-to-have #6** (why the Purchase click timed out) is untouched, but the
  new dialog logging is the instrument for it.

---

## Related issues / docs

- Stream-drop semantics: [stories/mcp-server.md](../stories/mcp-server.md) (reader ends without `done` ⇒ `streamDropped`)  
- Server lifecycle / expected stream-drop on stop: [stories/server-lifecycle.md](../stories/server-lifecycle.md)  
- Not the same as stop-recovery hangs ([031](031-early-exit-run-never-finalizes-last-run-recovery-hangs.md)) but compounds them: after crash there is no process left to finalize `last-run`.
