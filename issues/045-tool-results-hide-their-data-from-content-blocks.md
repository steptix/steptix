# 045 — tool results put their data only in `structuredContent`, so hosts that render `content` show the model a summary sentence

**Status:** open
**Area:** [src/mcp/tools.ts](../src/mcp/tools.ts) — `validated()`, which every one
of the 11 tools routes through; only `get_page_content`'s handler also changes.
Plus a §2 amendment in [stories/mcp-server.md](../stories/mcp-server.md).
**Opened:** 2026-08-08

> **This reverses a locked decision.** [stories/mcp-server.md](../stories/mcp-server.md) §2
> says, verbatim: *"Do not duplicate the full JSON as text."* Read §Reversal
> below before implementing — amending that line is part of this change, not an
> afterthought.

## Summary

Every *successful* tool result is built by `validated()`
([tools.ts:90](../src/mcp/tools.ts)), which puts a one-line human summary in
`content` and the actual data in `structuredContent`:

```js
content: [{ type: 'text', text: summary }, ...extra],
structuredContent: value,
```

MCP hosts differ over which half reaches the model. Claude Code gives the model
`structuredContent`; **OpenCode gives it `content`**. So on OpenCode the model
receives the sentence and none of the data.

Measured 2026-08-08 by calling `list_cdp_browsers` from both hosts against the
same server. Claude Code's model context received:

```json
{"running":[{"engine":"chrome","profile":"default","port":30424,
  "profileDir":"C:\\…\\.aiui\\cdp-profiles\\chrome-default",
  "tabs":[{"targetId":"2D4797E0EF88F52C30BB6A46F898238D",
           "title":"Credits | OpenRouter",
           "url":"https://openrouter.ai/settings/credits",
           "sessionId":null}]}],
 "available":[…2 profiles…],"foreign":[]}
```

OpenCode's received, in full — reported by the user from a live call:

```
1 running, 2 available (not started)
```

## Impact

**`close_cdp_tab` cannot be driven from OpenCode on the normal tool-call
path** (its code-mode path prefers `structuredContent` — see below). Its flow is
"call `list_cdp_browsers`, match the user's words against the tab titles
yourself, pass that tab's exact `targetId`" — and the summary contains no
`targetId`s. The tool's description instructs the model to do something the
model has not been given the data for. Same shape for `list_sessions` (session
ids, `cdp` binding, `tab` — the summary is only `"N open session(s)"`),
`get_last_run` (`tokens`; `reportPath` is one of the few fields that *does*
reach `content`, via that tool's summary at
[tools.ts:843](../src/mcp/tools.ts)), and the run tools (per-step results,
`captures`, `tokens` — their summary carries status, counts, first error,
`reportPath`, `sessionId` and a warnings count, so an agent there can still
continue or close the session, just not see what any step did).

## Root cause is on our side, per the spec

The MCP spec puts the duty on the **server**
([Tools § Structured Content, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)):

> For backwards compatibility, a tool that returns structured content SHOULD
> also return the serialized JSON in a TextContent block.

We ship a prose summary instead, so we are the ones not following it.

Two honest caveats, so nobody is blindsided: the keyword is `SHOULD`, and it is
the one normative keyword on that page left unbolded. And the current spec added
a second worked example (`list_users`) whose `content[0].text` **is** a prose
summary over an array `structuredContent` — an official example that does not
follow its own SHOULD. The weather example still does. So the spec supports this
change but does not compel it; the argument that actually compels it is the
measurement above.

OpenCode's behaviour is deliberate and conformant
(`packages/opencode/src/mcp/catalog.ts:75`, v1.18.15, latest at time of
writing):

```js
// paraphrased — source spells out `=== undefined || === null` and adds `as const`
if (result.content.length > 0 || result.structuredContent == null) return result
return { ...result, content: [{ type: "text", text: JSON.stringify(result.structuredContent) }] }
```

It stringifies `structuredContent` **only when `content` is empty**. Because we
always populate `content`, we take the early return every time. Its own test is
named *"preserves content when structuredContent is also present"*. Upgrading
OpenCode does not fix this.

Two warnings for whoever picks this up:

- **Do not trust [opencode#28567](https://github.com/anomalyco/opencode/issues/28567).**
  Its checklist marks this "resolved: now JSON-stringified to text content",
  which describes only the empty-`content` branch. It also claims `isError` is
  unchecked, when `catalog.ts:68` checks it — though note that entry was last
  touched 2026-07-08, a month before v1.18.15, so it may be stale rather than
  wrong when written. Read the source.
- OpenCode's `src/tool/code-mode.ts:109` uses the **opposite** precedence
  (`structuredContent` first), so behaviour differs by path within one host.
  Another reason to satisfy both halves rather than reason about hosts.

## Reversal: what mcp-server.md §2 says, and why it is now wrong

[stories/mcp-server.md](../stories/mcp-server.md) §2 currently reads:

> **`content[]`** is never empty: `content[0]` is a short **text summary** …
> the SDK synthesizes no text from `structuredContent`, and hosts that ignore
> structured output, including the Claude Code transcript, show only `content`.
> **Do not duplicate the full JSON as text.** The image block, when opted in, is
> appended.

That prohibition was reasonable on its own terms and is wrong in its premise.
It treats `content` as a channel every host is guaranteed to show, so a summary
there is enough. That fails for OpenCode, where `content` is the **model's**
channel and a summary is all the model gets.

Its supporting clause — *"hosts that ignore structured output, including the
Claude Code transcript, show only `content`"* — is also false of Claude Code and
should be corrected in the same edit. Measured across 49 persisted
`mcp__aiui__*` tool results: all 38 non-error ones record the serialized
`structuredContent`, and none records a content-block summary.

State the corrected rule precisely: **when `structuredContent` is present,
Claude Code records only that — transcript included.** It is a preference, not
blanket indifference to `content`; the other 11 records are `isError` results,
which carry no `structuredContent`, and their `content` text *is* persisted.
That fallback is why error messages still reach the model there, and it is
untouched by this change — `errorResult()` never routes through `validated()`.

**Amend §2 as part of this change.** Keep the summary requirement (it carries
counts, truncation and errors that raw JSON does not narrate), drop the
prohibition, and state the new rule: the serialized JSON is appended because a
host that renders only `content` would otherwise receive no data at all.

**Put the new rule in the right place.** The quoted bullet is the last of §2's
*folding algorithm* list, which describes the **run tools'** result — the
elided `(status, N/M passed, first error, reportPath)` is the giveaway. This fix
applies to every tool, so editing only that bullet leaves the story with no
all-tools statement of the content contract. The natural home is the all-tools
paragraph earlier in §2 (the one beginning "`structuredContent` must be a JSON
**object**, so the two list tools wrap their arrays"), with the run-tool bullet
amended to match.

While you are there, three stale counts say "seven" against 11 registered tools:
"**Seven tools**" ([mcp-server.md:218](../stories/mcp-server.md)), "this applies
to all seven schemas" ([:423](../stories/mcp-server.md)), and — in §Tests, the
section this issue's new all-11 guard lands in — "**MCP seam** … all **seven**
tools" ([:1095](../stories/mcp-server.md)). Leaving the last one ships a story
describing a seam test over seven tools next to a new guard over 11. (`:1157`'s
"all seven `vi.mock(...)` blocks" counts mocks, not tools — leave it.) Note
that a bare `Seven`→`11` leaves the section claiming 11 while its bullet list
still enumerates the original seven; the four newer tools are specced in
[mcp-cdp-browser.md](../stories/mcp-cdp-browser.md) (`start_cdp_browser`,
`list_cdp_browsers`), [cdp-tabs.md](../stories/cdp-tabs.md) (`close_cdp_tab`)
and [page-content.md](../stories/page-content.md) (`get_page_content`).
Half a sentence saying so covers both.

## Fix

Append the serialized `structuredContent` as a `content` text block, for
**every** tool.

```
content[0]        "1 running, 2 available (not started)"   ← unchanged summary
content[1]        {"running":[…]}                           ← NEW, compact JSON
content[2..]      …existing extra blocks…                   ← image, if opted in
structuredContent {running:[…]}                             ← unchanged
```

Do it inside `validated()` so it applies once rather than per handler, and make
it **unconditional** — no opt-out parameter. A per-tool opt-out cannot coexist
with the guard below ("every tool's `content` must contain its serialized
`structuredContent`"): any tool using it fails that test. If a genuine exception
ever appears, add the parameter *and* carve that tool out of the guard in the
same change, so the exception is visible rather than silent.

The degrade path (where `value` fails its own schema and `fallback` is used)
must serialize whatever it actually returns, so the two halves never disagree.

**Order:** summary, then JSON, then `extra`. `extra` is an image for the run
tools and should stay last.

**Serialize compact** (`JSON.stringify(value)`, no indent). Measured on a
25-step `run_steps` result: compact 9,601 chars vs pretty-printed 13,957 —
**+45%** for indentation a model does not need.

### `get_page_content` needs replacing, not stacking

Its handler passes the raw page text as `extra`
([tools.ts:952](../src/mcp/tools.ts)), which is why it is the only tool whose
**data** reaches a content-rendering host today. **Do not add the JSON block on
top of it:** `structuredContent.content` *is* the page, so the page would ship
twice in `content` plus once in `structuredContent`.

Drop the bespoke `extra` and let the standard block carry it. Measured on a
21,189-char page (299 newlines, 600 quotes):

| variant | chars | vs raw page |
|---|---|---|
| today `[summary, raw]` | 21,217 | 1.00x |
| proposed `[summary, json]` | 22,316 | **1.05x** |
| stacked `[summary, raw, json]` | 43,505 | 2.05x |

So replacing costs 5.2% and stacking costs 105%. (Of that 5.2%, escaping the
page body is 4.2% — 899 chars, being 299 newlines and 600 quotes — and the rest
is JSON keys and braces.) Keep the
existing comment's reasoning, updated: the page still travels twice (once in
`content`, once in `structuredContent`) and still must, because declaring an
`outputSchema` obliges the SDK to require `structuredContent`.

**Name the trade-off you are accepting, and note who does *not* pay it.** This
is the one tool whose entire product is human-readable page text. Anywhere the
raw `content[1]` block is read today, it becomes JSON-escaped text inside an
object: `{"sessionId":…,"content":"line1\nline2…"}`.

That reader is **not** Claude Code, despite what §2 says. Measured across 49
persisted `mcp__aiui__*` results in
`~/.claude/projects/…/*.jsonl`: 38 record the serialized `structuredContent`,
**0** record any content-block summary, and the remaining 11 are `isError`
results that have no `structuredContent` to record. `get_page_content` already
appears there as the escaped JSON object — Claude Code has never shown the raw
block, so it loses nothing here.

Nor is it OpenCode's human. Its TUI renders MCP tools through `GenericTool`,
which shows output only when `generic_tool_output_visibility` is on — and that
defaults to **false**, collapsing to three lines even when enabled
(`packages/tui/src/routes/session/index.tsx`, v1.18.15). The default view is a
one-line `⚙ tool input` row with no output at all.

So the copy that actually changes hands is the **model's**, on content-only
hosts: raw page text today, escaped JSON after. That is a real change and a
small one — a model reads escaped JSON fine, and it buys one rule across 11
tools. State it that way in the amendment; do not repeat §2's original mistake
of asserting something about a host's rendering that nobody measured.

### Two concerns that turn out not to apply

- **No base64 is duplicated.** `screenshotBase64` is destructured out before
  `validated()` ([tools.ts:536](../src/mcp/tools.ts)) and is absent from
  `runResultOutput`; it travels only as a native `image` block. Serializing
  `structuredContent` duplicates no image data, for any tool.
- **The `isError` path is a no-op.** Every non-`validated()` return goes through
  `errorResult()` ([tools.ts:76](../src/mcp/tools.ts)), which carries no
  `structuredContent`. Nothing to serialize.

### One concern that does apply: captures reach the model context

`captures` and `steps[].output` hold values scraped from the page — ids, tokens,
whatever a step captured. There is **no new recipient process**: the host
already receives them in `structuredContent` over a local pipe. But receiving
bytes locally is not egress, and on exactly the hosts this change targets —
the ones that drop `structuredContent` and keep `content` — those scraped values
will now **travel to a model provider that never received them before**. (On
Claude Code nothing changes: `structuredContent` already carries them to the
model and into the persisted transcript.)

That is the intended effect, and it is where this departs from the neighbouring
decision in the same design section: `mcp-server.md` §2 makes screenshots
**default-off** because "a screenshot of a failing page in this repo's own tests
is a live banking or GitHub session, egressed to a model provider."

The distinction is defensible — a screenshot would not exist at all unless
opted in, whereas captured text is already produced on every run and is the
data the tool exists to return — but say so in the §2 amendment rather than
leaving a reader to find the inconsistency.

## Tests

**One existing test fails**, and it is not an obvious one. Prototyped against
HEAD and run: [tests/mcp-cdp-seam.test.ts:832](../tests/mcp-cdp-seam.test.ts)
asserts `expect(text(result)).not.toContain('""')` over the *joined* content
blocks (guarding against a bare `chrome ""` in the summary when `profile` is
empty). The serialized JSON contains `"profile":""`, so it fails — under compact
and pretty-printed alike. Fix by asserting against `content[0]` alone rather
than the joined blob.

Everything else passes, including all `get_page_content` tests: they join blocks
and assert substrings, and the page text survives JSON escaping intact.

**The baseline is green** — 107 files / 1975 tests, 0 failures. If you see
failures in `tool-end-to-end`, `arrays-in-tools`, `extract-order-ids`,
`tool-reload` or `section-index-cli-parity`, your checkout is missing gitignored
artifacts, not broken by your change: the `file:../..` symlink
`fixtures/tools/node_modules/ai-ui-automation` (absent ⇒ `Cannot find package
'ai-ui-automation/tools'`) and `runner-core/dist/`. `npm run build` alone does
**not** create either. Separately, a `browser.close()` `afterAll` hook timeout
flits between `video-recording.test.ts` and `read-multiple.test.ts` across runs;
that is pre-existing flake, not you.

**Add a guard driven off the registered tool list**, so a new tool cannot
quietly opt out: for every tool, a successful result's `content` must contain
its serialized `structuredContent`. The existing guards only *list* tools —
`listToolsOverTheWire()` ([tests/mcp-schema-dialect.test.ts:46](../tests/mcp-schema-dialect.test.ts))
runs on deps whose every method throws — so actually calling all 11 needs a fake
client and a per-tool arguments table.

The fake already exists: `const fakeClient: ApiClient` at
[tests/mcp-cdp-seam.test.ts:86](../tests/mcp-cdp-seam.test.ts) implements all
eight `ApiClient` methods including `closeCdpTab`. Start from that one, not
`mcp-seam`'s — which has a `fakeClient` at its own line 85 and no `closeCdpTab`.

**A hand-written arguments table is itself the opt-out this is meant to
prevent**, so also assert its keys equal the registered tool list — the same
trick `mcp-schema-dialect.test.ts:182` already uses for schemas.

Worth one explicit test that `get_page_content` does not ship the page twice in
`content`.

## Related

- [stories/cdp-tabs.md](../stories/cdp-tabs.md) — `close_cdp_tab`, the tool this
  breaks worst.
- [stories/mcp-server.md](../stories/mcp-server.md) §2 — the decision being
  reversed; amend it here.
- The "page travels twice" trade-off is recorded in the code comment at
  [tools.ts:944](../src/mcp/tools.ts), not in
  [stories/page-content.md](../stories/page-content.md); this generalises it to
  every tool.
