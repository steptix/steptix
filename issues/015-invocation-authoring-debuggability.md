# 015 — Make `[tool:]` / `[skill:]` authoring errors easier to debug

**Status:** open / medium priority (one item already shipped)
**Area:** [src/parser/invocation-parser.ts](../src/parser/invocation-parser.ts) — shared invocation grammar; [src/tools/executor.ts:241](../src/tools/executor.ts#L241) — unknown-parameter error; [src/tools/registry.ts:78-118](../src/tools/registry.ts#L78-L118) — tool-not-found message
**Related:** [steptix-vscode/src/extension/steptix-config.ts](../steptix-vscode/src/extension/steptix-config.ts) — config resolution the diagnostics would reuse
**Opened:** 2026-05-20

## Summary

Authoring a tool/skill invocation in a test currently surfaces mistakes
one at a time, each only at run time, and several with cryptic messages.
A single broken `[tool: ...]` line walked a user through a chain of
guess-and-restart cycles:

1. Wrong `toolsDir` → "Tool not found … tools.dir does not exist".
2. Right dir, wrong arg name (`repos` vs the tool's declared `items`) →
   "received unknown parameter 'repos' — declared: [items]".
3. Right arg name but unquoted template (`items={{repos}}`) → the generic
   "expected '"', '[', a number, or true/false after '='".

Each required a server round-trip (and sometimes a restart) to discover
the *next* error. This issue collects the improvements that would shrink
that loop.

## Improvements

### 0. Unquoted-template hint — DONE
`items={{repos}}` now errors with
`template variable for argument 'items' must be quoted — write
items="{{...}}", not items={{...}}` instead of the generic value-forms
list. ([invocation-parser.ts `readArgValue`](../src/parser/invocation-parser.ts), regression test in
[tests/tool-call-parser.test.ts](../tests/tool-call-parser.test.ts)).

### 1. "Did you mean?" suggestions (small)
Append the nearest candidate (Levenshtein) to the two most common
mismatches:
- Unknown **parameter**: `unknown parameter "repos" — did you mean
  "items"? (declared: [items])` at [executor.ts:241](../src/tools/executor.ts#L241).
- Unknown **tool**: suggest the closest registered tool name in
  `buildNotFoundMessage` ([registry.ts:78](../src/tools/registry.ts#L78)).

Cheap, and directly collapses steps 1–2 above.

### 2. Static `steptix validate` / editor diagnostics (medium, highest value)
Walk every `[tool: ...]` / `[skill: ...]` in a test and check —
**without** launching a browser or calling the AI — that:
- the tool/skill exists in the catalogue resolved from `toolsDir` /
  `skillsDir`,
- every supplied arg name is declared (or the tool sets
  `acceptsExtraArgs`),
- required args are present,
- `{{vars}}` are quoted and resolvable.

Two surfaces:
- A CLI command (`steptix validate [glob]`) for CI / pre-run.
- Steptix **editor diagnostics** (squigglies) so the mistakes
  in steps 1–3 are visible before Run is ever pressed. Reuses the
  existing config resolution + `loadToolCatalogue` + `parseInvocation`.

### 3. Stale-server guard (medium)
The original confusion in this saga was a server running pre-migration
code (`steptix.config.ts` in an error string the source no longer emits).
Have the extension fetch a build stamp / version from the server and
warn when it's older than the workspace's, e.g. "Steptix server is
running an older build — restart `steptix serve`." Kills a whole class of
"why is it saying X when the code says Y?" debugging.

## Revisit when

- Tackling authoring ergonomics, or after another user report of a
  confusing invocation error.
- #2's editor-diagnostic half is the natural companion to any future
  "lint the test before running" feature.
