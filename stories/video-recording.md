# Video Recording — Capture a `.webm` of the Browser Session

## Context

Today the only visual trace of a run is **screenshots**: the harness captures
one per sub-action / AI turn / step end, and the HTML report renders them as a
clickable strip (a flip-book). That covers most debugging, but it misses
*motion* — animations, transitions, a spinner that never resolves, focus
jumping, a layout shifting under the AI's click. For flaky/timing failures a
continuous video is far more diagnostic than discrete frames.

The engine underneath is Playwright, which records video natively: pass
`recordVideo` to `browser.newContext()` and it writes a `.webm` of the whole
context, finalised when the context closes. So the feature is mostly *plumbing*
— wire a config flag to that option, then surface the resulting file.

This spec covers three things the reader (and the original request) asked:
**where the setting lives**, **whether Steptix can load the video**, and
**how the report links to it**.

## Enabling it — a flag in `steptix.config.json`

Video is a **browser capture** concern, so it belongs in the existing
`browser` block of `steptix.config.json`, right next to the screenshot toggles it
resembles (`fullPageScreenshots`, `captureScreenshotsPerAction`):

```jsonc
{
  "browser": {
    "headed": true,
    "video": "retain-on-failure"   // ← NEW. "off" (default) | "on" | "retain-on-failure"
  },
  "reports": {
    "outputDir": "./reports"
  }
}
```

- **Type:** add `video?: 'off' | 'on' | 'retain-on-failure'` to `BrowserConfig`
  ([src/config/types.ts:60-99](../src/config/types.ts#L60-L99)), default `'off'`
  in [src/config/defaults.ts](../src/config/defaults.ts). Boolean `true`/`false`
  are accepted as sugar for `'on'`/`'off'`. The value names match Playwright's
  own `video` option vocabulary. The JSON schema is generated from the TS types
  by `npm run build:schema`, so the new key becomes valid/auto-completed in
  editors with no separate schema edit.
- **Global, not per-test** (the requested shape). One setting turns it on for
  every run of the project. A per-test `## Config - video: true/false` override
  is a natural later extension (the same way `cdp`/`timeout` can be set per test
  — see [cdp-connection.md](cdp-connection.md)), but is out of scope for v1.
- **What the three values mean:** `"off"` (default) records nothing; `"on"`
  records every run and keeps the `.webm`; `"retain-on-failure"` records every
  run but **deletes the `.webm` when the test passes**, keeping it only for
  failed/aborted runs — you save disk while still capturing exactly the runs
  worth inspecting.
- **Default off** on purpose: recording costs disk (a 30-second run is ~1-3 MB)
  and a little CPU. Authors opt in when they want it.
- **Discoverability:** include `"video": "off"` in the `steptix init` template
  ([src/cli/commands/init.ts:86-104](../src/cli/commands/init.ts#L86-L104)) so
  new projects see the knob exists.

A forward-compatible extension (not v1): widen `video` to also accept an object
(`{ "mode": "on", "size": { "width": 1280, "height": 720 } }`) for explicit
recording resolution. The string form stays valid — it's just `mode` with the
viewport size implied.

## How it works

```
config.browser.video=true
   │
   ▼
browser.newContext({ recordVideo: { dir: <outputDir>/videos } })   ← manager.ts:810
   │   (Playwright records the whole context; one .webm per page)
   ▼
context.close()  ──►  page.video().path()  (resolves the final .webm path)
   │
   ▼
TestReport.videoRelPath = "videos/<timestamp>-<test>.webm"
   │
   ▼
report HTML  ──►  <video src="videos/…webm" controls>            ← generator.ts
```

1. **Record.** At context creation
   ([src/browser/manager.ts:810](../src/browser/manager.ts#L810)) add, when the
   flag is set:
   ```ts
   ...(config.video && {
     recordVideo: { dir: path.join(config.reports.outputDir, 'videos') },
   }),
   ```
   Playwright records at the viewport size and names files with a random hash.
2. **Finalise.** The `.webm` is only written when the context closes (the runner
   already closes all browsers at test end). After close, `page.video().path()`
   resolves to the actual file. Rename it to a stable, report-matching name
   (`<timestamp>-<safeTestName>.webm`) under `<outputDir>/videos/`.
3. **Apply retention.** When `video` is `"retain-on-failure"` and the run
   **passed**, delete the `.webm` here and skip the report link. When it
   failed/aborted (or `video` is `"on"`), keep it.
4. **Carry the path into the report.** Add `videoRelPath?: string` to
   `TestReport` ([src/report/types.ts](../src/report/types.ts)); the session/run
   teardown sets it to the path **relative to the report HTML** (e.g.
   `videos/2026-06-02_10-15-03-checkout.webm`).
5. **Link it in the report** (next section).

## The report link — file-linked, NOT embedded

This is the one real design decision. Screenshots in the report are **embedded
as base64 data URIs** — `src="${toDataUri(step.screenshotBase64)}"`
([src/report/generator.ts:313](../src/report/generator.ts#L313),
[490](../src/report/generator.ts#L490),
[548](../src/report/generator.ts#L548)) — which makes the HTML self-contained.
A video is 100×-1000× larger; base64-inlining a multi-MB `.webm` would bloat the
HTML into something a browser struggles to open. So video must be **file-linked**
via a relative path, not embedded:

```html
<!-- rendered into the report header, beside the run summary -->
<div class="video-block">
  <div class="video-label">Session recording</div>
  <video class="session-video" src="videos/2026-06-02_10-15-03-checkout.webm"
         controls preload="metadata"></video>
</div>
```

Because the report lives at `<outputDir>/<file>.html` and the video at
`<outputDir>/videos/<file>.webm`, the relative `videos/<file>.webm` resolves
naturally when the HTML is opened from disk.

**Tradeoff to state plainly:** the report stops being a single portable file. To
move/email it you now need the `videos/` dir too (screenshots still travel inside
the HTML). For local debugging and Steptix (below) this is a non-issue; a
"self-contained export" (zip, or base64-inline short clips) is a possible
follow-up.

## Steptix & Flick access — yes, via the report

**The question "does Steptix have access to load the video?" — yes, for free,
through the report it already opens.**

Steptix's **Open Last Report** command does
`vscode.env.openExternal(vscode.Uri.file(reportPath))`
([steptix-vscode/.../commands/index.ts:431-449](../steptix-vscode/src/extension/commands/index.ts#L431-L449)) —
it hands the absolute report path to the OS, which opens the local HTML in the
real browser. A real browser opening a local file **will load and play a
relative-linked sibling `.webm`**. So:

- **No Steptix code change is needed for the basic feature.** The server
  already announces `reportPath` on the `done` event
  ([runner-core/src/protocol.ts:129-138](../runner-core/src/protocol.ts#L129-L138));
  Steptix already opens it; the embedded `<video>` rides along.
- It works because **Steptix and the server run on the same machine**
  (localhost:3100 in the normal setup), so the file paths the server writes are
  reachable when the report opens.

What does **not** work, and why:

- **The live results webview** (the inline panel that streams step results as
  they happen) gets screenshots as base64 over SSE
  ([session-manager.ts:838](../src/server/session-manager.ts#L838)). Video can't
  ride that channel — it's finalised only at context close and is far too large
  to stream inline. **Video is a post-run, report-only artifact**, surfaced via
  "Open Last Report", not the live panel.
- **A remote server** (VS Code client on a different machine than the server)
  breaks the file link — `videos/…webm` points at a path that only exists on the
  server. Screenshots still show (they're base64-in-HTML); the video link 404s.
  Fix is the Tier-2 / HTTP option below. The common localhost case is unaffected.

**Flick** is the chat-style Sessions-API client; it renders results inline and
doesn't currently open the HTML report, so it gets video only if/when it adds an
"open report" affordance — out of scope here.

## Phasing

**Tier 1 — report-embedded link (recommended first ship). No protocol or
extension change.**
- `browser.video` flag → record → rename → `TestReport.videoRelPath` →
  `<video>` in the report template.
- Entirely **main-package** work (`src/config`, `src/browser`, `src/report`,
  `src/server` report assembly). `runner-core` and the Steptix extensions are
  untouched, so **no extension version bump** (per CLAUDE.md the bump is only for
  code bundled into a VSIX).
- Steptix's existing "Open Last Report" plays it. Done.

**Tier 2 — first-class "Open Video" (optional, later). Touches the shared
protocol.**
- Add `videoPath?: string` to `DoneEvent`
  ([runner-core/src/protocol.ts:129-138](../runner-core/src/protocol.ts#L129-L138))
  and its `api-client` mirror, so a client can open the `.webm` directly without
  going through the report.
- Add a `steptix.openLastVideo` command (sibling to `openLastReport`).
- Because `runner-core` bundles into the Steptix VSIXes, this is a **patch
  bump** for `runner-core` + both steptix variants (per CLAUDE.md), and a
  `flick-vscode` opportunity if it grows report access.
- Optional further step for remote servers: a `GET /sessions/:id/video` endpoint
  (or static-serve `outputDir`) so the link works off-box; the report `<video>`
  `src` would then point at the API URL instead of a relative path.

## Caveats & limitations

| # | Limitation | Detail |
|---|---|---|
| 1 | **CDP can't record** | `connectOverCDP` attaches to a browser the harness didn't create; Playwright only records contexts it launched. Add `video` to the "ignored under CDP" warn list ([manager.ts:942-944](../src/browser/manager.ts#L942-L944)) so the user isn't left wondering. |
| 2 | **Post-run only** | The `.webm` finalises on context close, so there's no live/streaming view — it's a forensic artifact, available once the run ends. |
| 3 | **One file per page** | Each tab/popup in the context records separately; multi-page and multi-browser (`openBrowser`) runs produce several `.webm`s. v1 links the **main page's** video; surfacing the rest is a follow-up. |
| 4 | **Disk + perf** | ~1-3 MB per short run, minor CPU. Hence default off, and consider pruning old `videos/` alongside any future report retention policy. |
| 5 | **Headed & headless** | Both record fine. |
| 6 | **Portability** | File-linked, so the `.html` alone no longer carries the video (screenshots still do). See the report section. |
| 7 | **Server path: link appears at session close** | On the server/Steptix path the recorded context is **reused across runs**, and the `.webm` finalises only when the **session is closed** — an explicit session delete or server shutdown (NOT at the end of each run, and NOT on a plain re-run that reuses the session). So the video link can lag well behind the run that produced it. The CLI path closes per run, so it's immediate there. |
| 8 | **Reusable session: last run wins** | A reused session keeps **one** context-spanning recording across all its runs; under `retain-on-failure` that single `.webm` is kept/dropped by the **last** run's outcome — a passing final run drops a recording that contains an earlier failure. |
| 9 | **Orphan `.webm` on a no-report run** | A recorded server session that produces no linkable report (e.g. a zero-step batch) leaves its hash-named `.webm` in `videos/`. Harmless but accumulates — disk hygiene, not correctness. |

(Robustness note: an unrecognised `video` value — e.g. a typo in a hand-edited
config the JSON schema would reject — falls back to `off` with a logged warning,
never silent record-and-keep.)

## Implementation sketch (Tier 1)

| Area | Change |
|---|---|
| [src/config/types.ts](../src/config/types.ts#L60) | `video?: 'off' \| 'on' \| 'retain-on-failure'` on `BrowserConfig` |
| [src/config/defaults.ts](../src/config/defaults.ts) | default `video: 'off'` |
| [src/cli/commands/init.ts](../src/cli/commands/init.ts#L86) | add `"video": "off"` to the template (discoverability) |
| [src/browser/manager.ts](../src/browser/manager.ts#L810) | `recordVideo: { dir }` on `newContext` when not `'off'`; add to CDP ignored-config warning |
| [src/report/types.ts](../src/report/types.ts) | `videoRelPath?: string` on `TestReport` |
| runner/server teardown | after context close, resolve `page.video().path()`; on a **passing** run when mode is `retain-on-failure`, delete the `.webm` and leave `videoRelPath` unset; otherwise rename under `<outputDir>/videos/` and set `videoRelPath` ([session-manager.ts:2570](../src/server/session-manager.ts#L2570) report assembly; the CLI path in [test-runner.ts:926](../src/runner/test-runner.ts#L926)) |
| [src/report/template.ts](../src/report/template.ts) + [generator.ts](../src/report/generator.ts#L76) | render a `<video controls>` block when `videoRelPath` is set |
| tests | config parse (tri-state + boolean sugar); manager passes `recordVideo` when not `'off'` and omits it under CDP; retain-on-failure **deletes** the `.webm` on pass / **keeps** it on fail; report renders the `<video>` block when `videoRelPath` present and omits it otherwise |

No `runner-core`/Steptix changes in Tier 1 → no extension version bump.

## Decisions (settled)

1. **Config shape:** a string tri-state `browser.video: "off" | "on" |
   "retain-on-failure"` (default `"off"`), matching Playwright's own `video`
   vocabulary. Not a plain boolean (it can't express three states); the object
   form (`{ mode, size }`) is a backward-compatible later extension if explicit
   recording resolution is ever wanted. Boolean `true`/`false` accepted as sugar
   for `"on"`/`"off"`.
2. **Retention:** `"retain-on-failure"` records every run, then deletes the
   `.webm` on a passing run and keeps it on failure/abort — saving disk while
   keeping the runs worth inspecting.
3. **Scope:** Tier 1 only for now — the report-embedded `<video>` link, no
   protocol/extension change, no version bump. The dedicated "Open Video"
   command (Tier 2) is deferred.
