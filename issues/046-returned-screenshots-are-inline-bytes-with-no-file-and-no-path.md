# 046 — a returned screenshot is inline bytes with no file and no path, so a host that cannot render images loses it with nothing to point at

**Status:** open
**Area:** [src/mcp/tools.ts](../src/mcp/tools.ts) (`validated`, `outcomeToResult`,
`screenshotResult`), [src/mcp/run-fold.ts](../src/mcp/run-fold.ts),
[src/mcp/schemas.ts](../src/mcp/schemas.ts) (`runResultOutput`,
`getPageContentOutput`). Possibly
[src/report/generator.ts](../src/report/generator.ts) if the server writes the
file instead.
**Opened:** 2026-08-09
**Reported from:** Agent Fleet Console (OpenCode-based) — the model said *"the
completed-step screenshot is shown inline above"* and no screenshot was shown.

## Context — read this first

When a run returns a screenshot, the picture travels to the agent as **raw
bytes inside the tool result**. It is not a file. Nothing in this repo ever
writes a `.png` — I grepped `src/` for `.png` and the only hits are the string
`"image/png"` in mime types.

So a screenshot exists in exactly three forms, all base64, none of them a path:

| Where | Form | Persists? |
|---|---|---|
| The SSE `step:pass` / `step:fail` event | `data:image/png;base64,…` string | No — in transit only |
| The HTML report | `<img src="data:image/png;base64,…">` embedded in the markup ([generator.ts:418](../src/report/generator.ts), [:621](../src/report/generator.ts), [:679](../src/report/generator.ts)) | **Yes** — this is the only durable copy |
| The MCP tool result | `{ "type": "image", "data": "iVBOR…", "mimeType": "image/png" }`, appended as the last block of `content` ([tools.ts:700](../src/mcp/tools.ts) for a run, [:617](../src/mcp/tools.ts) for `get_page_content`) | No |

Two consequences follow, and together they are the whole issue.

**The agent is never told where a screenshot is, because there is nowhere.** The
run result has no field naming one — not a path, not a URL, not an index into
the report. `runResultOutput` carries `reportPath` and that is it. If the image
block does not survive the trip to the model, the model has *no* handle on the
picture and nothing truthful it can say about it.

**A host that cannot render an image block loses the picture silently.** Issue
045 established that hosts disagree about which half of a tool result reaches
the model — Claude Code reads `structuredContent`, OpenCode reads `content`. Our
image block *is* in `content`, so it is on the right side of that split, but
being in `content` is not the same as being rendered. Nothing in the result says
"an image is attached", so a host that drops the block leaves the model unable to
tell that anything is missing.

That is why the model said the screenshot was "shown inline above". **That
sentence is not evidence the block was emitted.** It is what a model says when it
asked for a screenshot and assumes one arrived. It cannot currently know either
way.

Also worth knowing before anyone goes looking for a switch: `reports.embedScreenshots`
and `reports.includeScreenshots` are declared in
[config/types.ts](../src/config/types.ts), defaulted, and in the JSON schema —
and **read by no runtime code at all**. The generator always embeds. There is no
setting that makes screenshots into files. (Those two dead knobs are already
listed as out of scope in [stories/run-settings.md](../stories/run-settings.md);
this issue does not change that, it just explains why the search comes up empty.)

## What the user can do right now

The screenshots are in the report. Open `reportPath` from the run result — the
images are embedded in it. Measured on a two-step run: 262 KB of HTML with 8
embedded PNGs under `capture: "every-step"`, against 138 KB and zero for the same
steps with capture off.

## Narrowing which failure mode this is

Three things could produce "no screenshot", and they need different fixes. In
order of how cheap they are to rule out:

1. **We dropped it on purpose.** Over 1.5 MB of base64
   (`MAX_SCREENSHOT_BASE64`, [run-fold.ts:126](../src/mcp/run-fold.ts)) is
   dropped with a warning on the run result — `Screenshot dropped: NNNKB of
   base64 exceeds the size cap`. Check `warnings[]`. Far more likely with
   `full_page: true`, where a long page's PNG runs to several MB.
2. **We never had one to return.** A passing step carries no screenshot unless
   per-action capture is on, so `screenshots_return: "final"` on a clean run with
   capture off returns nothing — and the fold warns naming `capture`. Again:
   check `warnings[]`.
3. **We emitted the block and the host did not render it.** No warning, and the
   raw tool output contains a block with `"type": "image"`. This is the case the
   fix below is for.

The distinction matters because (1) and (2) are already diagnosed in the result
and (3) is not.

## The gap

For a host in case 3 there is currently **no route to the picture at all** short
of a human opening a 262 KB HTML file by hand. The model cannot help, because
the only artifact is that report — there is no screenshot to name.

## Proposed fix, in two parts

The parts are independent and the first is worth doing regardless of what we
decide about the second.

### Part 1 — say what was attached, in text (cheap)

`validated()` builds the summary line every host shows. It currently says nothing
about the image. Add a sentence when an image block is present:

```
Screenshot: attached as an image block (142 KB). If you cannot see it, the same
picture is embedded in the report at <reportPath>.
```

That single line means a model on a content-only host can say something true
instead of guessing, and it points at the copy that definitely exists. It costs
one line of text per result that carries an image, and nothing otherwise.

### Part 2 — write the file and return its path (the real fix)

Write the returned screenshot to a `.png` and add a nullable `screenshotPath` to
`runResultOutput` and `getPageContentOutput`. Then any host can open it, the
model can cite it, and nobody pays for it unless they look.

Three decisions this needs, none of them obvious:

**Who writes it — the MCP or the server?** The MCP is simpler: `foldRun` already
holds the bytes and the tool knows `projectRoot`, so it is a file write and one
field. The server is more *correct*: it owns `reportOutputDir`, it has the bytes
at capture time, and doing it there would give Steptix and flick the same
paths for free instead of making this an MCP-only nicety. It is also the larger
change, and it puts a file write on the hot path of every captured step rather
than on the few that get returned. **Recommendation: MCP side**, because the
problem being solved is specifically "the agent has no handle on the picture",
and widening it to every client is a different story.

**Where the file goes.** `<reportOutputDir>/screenshots/` is the obvious answer
and keeps it beside the report it belongs to. Note `reportOutputDir` is
project-anchored per session, so the MCP would need it from the result rather
than re-deriving it — `reportPath`'s directory is the honest source.

**Whether files accumulate.** A deterministic name per session
(`<sessionId>-latest.png`) overwrites and never grows; a timestamped name keeps
history and grows without bound. The reports dir already holds 1092 files, so
"it is the junk drawer" is an established position — but a screenshot written on
every failing run is a faster-growing junk drawer than a report per run.
**Recommendation: name it after the report** (`<report-base-name>.png`, or
`-step-N.png` if we ever return more than one), so a screenshot's lifetime
matches its report's and the existing "delete old reports" habit cleans both.

## Not doing

- **Making `reports.embedScreenshots` real** so the report links files instead of
  embedding them. Tempting to fold in — it would produce the paths this issue
  wants as a side effect — but it changes what every existing report looks like
  and breaks the single-file-you-can-email property. Separate change, and one
  that needs its own decision about the reports already on disk.
- **Returning a `data:` URI as text** so a text-only host can at least see
  *something*. It would be a 190 KB unreadable string in the model's context.
  Worse than nothing.
- **Assuming this is an OpenCode bug and stopping there.** Even if it is, case 3
  leaves us with no path to the picture, and that is our gap rather than the
  host's.

## Revisit / done when

- A returned screenshot has a path in the tool result, and opening that path
  shows the same image the block carried.
- A model on a content-only host can tell the user where the screenshot is
  without having seen it.
- The three "no screenshot" causes above are distinguishable from the result
  alone, without reading the source.
