# 057 — `[tool:] otherwise …` is still silently dropped on the paths the validator does not see

**Status:** open / known limitation — the parse-time half of decision 12 shipped
with [stories/step-failure-outcomes.md](../stories/step-failure-outcomes.md);
the run-time half exists for the contradiction rule only.
**Area:**
[src/parser/markdown.ts](../src/parser/markdown.ts) — `extractHooks` (~line
1429) checks a hook line's flow-control claim and nothing else;
[src/runner/test-runner.ts](../src/runner/test-runner.ts) (~line 829) — the hook
loop excludes a `toolCall` from the tail;
[src/server/session-manager.ts](../src/server/session-manager.ts) (~line 5276) —
the raw Sessions API dispatches the tool branch off `originalStep`;
[src/mcp/tools.ts](../src/mcp/tools.ts) — `run_steps`, which posts step strings
through that same loop.
**Related:** `directiveFailureTail` / `directiveFailureTailError` and
`failureTailDirective` in
[src/parser/failure-tail.ts](../src/parser/failure-tail.ts) — the refusal these
paths could use, and `failureTailContradictionError` beside it, which they
already do.
**Opened:** 2026-09-11

## Summary

`[tool: fetch_orders] otherwise continue` parses a tail nothing reads: the loops
dispatch the tool off the raw line, the tool runs, and the tail is consulted by
nobody. Decision 12 answers that with two halves — `parseFailureTail` returns
null for the line, and the `## Steps` validator refuses it by name — and the
second half is the one an author actually sees.

Four arrivals never reach that validator — three loops and one parser — and on
every one the line still runs the tool and drops the tail without a word:

| Path | What refuses a `[tool:]` tail | What refuses the decision-8 contradiction |
|---|---|---|
| `## Hooks` / project `defaultHooks` | nothing (`extractHooks`) | nothing at parse; the CLI hook loop, at run time |
| A `[skill: …]` body read at run time | nothing | the four loops, at run time |
| Raw Sessions API `POST /sessions/:id/steps` | nothing | the server's own step loop |
| MCP `run_steps` | nothing | the same loop |

The asymmetry is the point: every one of those loops already reads the authored
line before it dispatches anything, and every one already refuses the
contradiction there. `failureTailDirective(line)` is the same shape of question,
asked of the same string, and would cost the same nothing.

## What it looks like

    ## Hooks
    - before: [tool: seed_orders] otherwise continue

The hook runs `seed_orders`. If it throws, the hook fails the run — `otherwise
continue` had no effect at any point, and no message ever said so. The identical
line under `## Steps` in the same file is refused at parse time with *a [tool:]
step does not take an "otherwise" tail*.

## Why it is not fixed here

The failure-outcomes work closed the silent-drop hole where authors meet it — a
step in a file — and the run-time backstops it added were for decision 8, whose
consequence (a line asking for two endings at once) cannot be resolved either
way. Dropping a tail is a lesser fault: the tool still does what the line's
bracket says, and only the tail is lost. Adding four more refusal sites is a
change to four loops plus `extractHooks`, each with its own test through its own
real entry, and it wants doing in one pass rather than as a rider.

## What a fix looks like

1. `extractHooks`: ask `failureTailDirective(instruction)` beside the existing
   `isReturnClaim` check and throw `directiveFailureTailError(…, kind, ' in
   <file>')` — the same shape, thrown rather than warned, for the same reason.
2. The CLI hook loop, the Sessions API loop, the errand loop and the Electron
   loop: compute the directive beside the `failureTailContradiction` each already
   computes, and fail the step with `directiveFailureTailError` where they fail
   it with `failureTailContradictionError`. (The errand loop has no tool branch
   today, so it is the cheap one — and the one that will need it when it gains
   one.)
3. Tests through the real entries, as the contradiction has: a `## Hooks` parse,
   an api-server POST of `[tool: x] otherwise continue`, and the CLI hook loop.

## Revisit when

- Someone reports a hook or a raw-API step whose `otherwise` did nothing, or
- the errand loop gains a tool branch, or
- any of those loops is touched for another tail reason.
