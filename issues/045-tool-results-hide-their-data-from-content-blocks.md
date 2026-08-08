# 045 — tool results put their data only in `structuredContent`, so hosts that render `content` show the model a summary sentence

**Status:** open
**Area:** [src/mcp/tools.ts](../src/mcp/tools.ts) — `validated()` and all 11 tool handlers
**Opened:** 2026-08-08

## Summary

Every tool result is built by `validated()`
([tools.ts:90](../src/mcp/tools.ts)), which puts a one-line human summary in
`content` and the actual data in `structuredContent`:

```js
content: [{ type: 'text', text: summary }, ...extra],
structuredContent: value,
```

MCP hosts differ over which half they put in front of the model. Claude Code
reads `structuredContent`; **OpenCode reads `content`**. So on OpenCode the
model receives the sentence and nothing else — none of the data.

Measured 2026-08-08 by calling `list_cdp_browsers` from both hosts against the
same server. Claude Code received:

```json
{"running":[{"engine":"chrome","profile":"default","port":30424,
  "profileDir":"C:\\…\\.aiui\\cdp-profiles\\chrome-default",
  "tabs":[{"targetId":"2D4797E0EF88F52C30BB6A46F898238D",
           "title":"Credits | OpenRouter",
           "url":"https://openrouter.ai/settings/credits",
           "sessionId":null}]}],
 "available":[…2 profiles…],"foreign":[]}
```

OpenCode received, in full:

```
1 running, 2 available (not started)
```

## Impact

**`close_cdp_tab` cannot be driven from OpenCode at all.** Its whole flow is
"call `list_cdp_browsers`, match the user's words against the tab titles
yourself, pass that tab's exact `targetId`" — and the summary contains no
`targetId`s. The tool's own description instructs the model to do something the
model has not been given the data for. Same shape of problem for
`list_sessions` (session ids, `cdp` binding, `tab`), `get_last_run`
(`reportPath`), and `run_steps`/`run_test_file` (per-step results).

This is not OpenCode's bug, and upgrading does not fix it — see below.

## Root cause is on our side, per the spec

The MCP spec puts the duty on the **server**
([Tools § Structured Content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)):

> For backwards compatibility, a tool that returns structured content SHOULD
> also return the serialized JSON in a TextContent block.

Its worked example does exactly that — the `content` text block holds
`{"temperature": 22.5, "conditions": "Partly cloudy", "humidity": 65}`, the
serialized form of `structuredContent`, not a prose summary of it. We ship a
summary instead, so we are the ones not following the recommendation.

OpenCode's behaviour is deliberate and conformant
(`packages/opencode/src/mcp/catalog.ts`, v1.18.15, latest at time of writing):

```js
if (result.content.length > 0 || result.structuredContent == null) return result
return { ...result, content: [{ type: "text", text: JSON.stringify(result.structuredContent) }] }
```

It stringifies `structuredContent` **only when `content` is empty**. Because we
always populate `content`, we take the early return every time. Its own test is
named *"preserves content when structuredContent is also present"*.

Two warnings for whoever picks this up:

- **Do not trust [opencode#28567](https://github.com/anomalyco/opencode/issues/28567).**
  Its checklist marks this "resolved: now JSON-stringified to text content",
  which describes only the empty-`content` branch, and claims `isError` is
  unchecked when `catalog.ts:68` plainly checks it. Read the source.
- OpenCode's `src/tool/code-mode.ts` uses the **opposite** precedence
  (`structuredContent` first). So behaviour differs by path within one host —
  another reason to satisfy both halves rather than reason about hosts.

## Fix

Append the serialized `structuredContent` as a `content` text block, for
**every** tool.

```
content[0]        "1 running, 2 available (not started)"     ← unchanged summary
content[1]        "{\n  \"running\": [ … ]\n}"                ← NEW
structuredContent { running: […] }                            ← unchanged
```

Do it in `validated()` so it applies once rather than per handler, and default
it **on** — a new tool should get this without anyone remembering. The
`validated()` degrade path (where `value` fails its own schema and a `fallback`
is used) should serialize whatever it actually returns, so the two never
disagree.

### `get_page_content` needs replacing, not stacking

It is the one tool that already passes `extra` — the raw page text as a second
content block ([tools.ts:952](../src/mcp/tools.ts)) — which is why it is the
only tool that works on both hosts today. **Do not add the JSON block on top of
it:** `structuredContent.content` *is* the page, so the page would ship twice in
`content` plus once in `structuredContent`, three copies of a payload that can
be 20 000 chars.

Drop the bespoke `extra` and let the standard serialized block carry it. The
page then reaches the model JSON-escaped rather than raw, which is a real but
small readability cost, and it makes the rule uniform — which is the point.
Keep the existing comment's reasoning, updated: the page still travels twice
(once in `content`, once in `structuredContent`) and still must, because
declaring an `outputSchema` obliges the SDK to require `structuredContent`.

### Cost

Close to nothing on Claude Code, which drops `content` blocks — measured
2026-08-07, see the memory note on host rendering. On OpenCode it is the only
thing that reaches the model. Worst case is a host that renders both, where a
small listing doubles; acceptable for a few KB, and the reason
`get_page_content` gets the replace-not-stack treatment.

## Tests

- `tests/mcp-seam.test.ts` and `tests/mcp-cdp-seam.test.ts` already join all
  content blocks before asserting substrings, so most should survive. The
  `get_page_content` ones that assert the page appears in `content` still pass,
  since the page text is inside the JSON — but check the escaping does not
  break any assertion containing quotes or newlines.
- Add a guard that is hard to regress: for every registered tool, a successful
  result's `content` blocks must contain the serialized `structuredContent`.
  Driving it off the tool list means a new tool cannot quietly opt out — the
  same trick the dialect and inventory guards already use.
- Worth one explicit test that `get_page_content` does **not** ship the page
  twice in `content`.

## Related

- [stories/cdp-tabs.md](../stories/cdp-tabs.md) — `close_cdp_tab`, the tool this
  breaks worst.
- [stories/mcp-server.md](../stories/mcp-server.md) §2 — reasons the two halves
  are populated, and calls the duplication "wire-only, not context". That is
  true only where the host drops one half; on OpenCode `content` **is** the
  context. Worth amending when this lands.
- [stories/page-content.md](../stories/page-content.md) — records the "the page
  travels twice" trade-off that `get_page_content` already accepted, which this
  generalises to every tool.
