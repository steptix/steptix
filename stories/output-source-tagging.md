# Tag outputs by source (parameter / capture / toolOutput)

## Background

The framework keeps every session-scope variable in a single
`Record<string, string>` (`session.outputs`), regardless of how it was
set. Three code paths write to it
([session-manager.ts:1456](../src/server/session-manager.ts#L1456),
[:1551](../src/server/session-manager.ts#L1551),
[:1675](../src/server/session-manager.ts#L1675)). Downstream consumers
(flick-vscode's batch outputs panel, testbench's Variables panel) can't
tell a parameter apart from a runtime capture apart from a skill's
return value.

## Source taxonomy

A new discriminator with three values:

- **`parameter`** — declared in `## Parameters`, resolved once at run
  start (often by prompting the user or reading `.env`), persisted for
  the session.
- **`capture`** — extracted from the page mid-run via the `[output: X]`
  prefix or the `[store as: X]` step modifier.
- **`toolOutput`** — returned by a `[tool: ...]` or `[skill: ...]`
  invocation, aliased into the caller's scope via `setVar` / skill
  `## Outputs`.

Closed union. New sources require a protocol bump.

> **Note on secrets**: source tagging is orthogonal to the existing
> name-based masking. Variables whose names match the secret regex
> (`password|secret|token|apikey|api_key`) continue to render masked
> regardless of source. See
> [issue 013](../issues/013-secret-masking-duplicated-and-divergent.md)
> for the masking implementation.

## Wire-protocol changes

### A. Streaming `capture` event (runner-core)

Add a `source` discriminator to
[runner-core/src/protocol.ts:112-117](../runner-core/src/protocol.ts#L112-L117):

```ts
export interface CaptureEvent {
  type: 'capture';
  line: number;
  name: string;
  value: string;
  source: 'capture' | 'toolOutput';   // ← NEW
}
```

`parameter` is **not** in this enum — parameters are emitted via the
separate `parametersResolved` event, which already implicitly tags them
as parameters by event type. No new event needed.

**Backward compat**: field is required on new emitters, but legacy
clients ignore unknown fields. New clients that read `source` must
tolerate it being absent when talking to a server that hasn't been
upgraded (treat absent as `'capture'` — the conservative default).

### B. Sessions API `/sessions/:id/steps` response

Add a parallel `outputSources` map to the existing `outputs`:

```ts
{
  ...existing fields,
  outputs: Record<string, string>,
  outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput'>  // ← NEW
}
```

Same keys, just labels. Additive, so legacy clients (anything not yet
updated) keep working.

## Server-side implementation

In `SessionManager`:

1. Add `outputSources: Record<string, 'parameter' | 'capture' | 'toolOutput'>`
   alongside `session.outputs`.
2. **Label at each write site** (not via post-hoc heuristics):
   - **Parameter resolution** (where `resolvedParameters` is first
     populated from `## Parameters`): seed
     `session.outputSources[key] = 'parameter'` for every initial key.
   - **Tool/skill output**
     ([:1456](../src/server/session-manager.ts#L1456)): set
     `'toolOutput'` for each `aliasName`.
   - **`[output: X]` capture**
     ([:1551](../src/server/session-manager.ts#L1551)): set `'capture'`
     for each `varName`.
   - **End-of-step sweep**
     ([:1675](../src/server/session-manager.ts#L1675)): for keys not yet
     labeled (i.e., `[store as:]` modifier values), default to
     `'capture'`. Don't overwrite existing labels.
3. **Streaming `capture` emit**
   ([:1457-1462](../src/server/session-manager.ts#L1457-L1462) and
   [:1555-1559](../src/server/session-manager.ts#L1555-L1559)): pass
   `source: 'toolOutput'` and `source: 'capture'` respectively on the
   existing two emit sites.
4. **Final response payload**
   ([:1855-1864](../src/server/session-manager.ts#L1855-L1864)): include
   `outputSources: { ...session.outputSources }`.

Naming collisions (a param name later being overwritten by a capture)
keep the original `'parameter'` label — surprising-but-explicit;
alternative is "last-write-wins" but that hides the parameter's
identity. **Decision: keep the first label** since values themselves
overwrite anyway.

## Client changes

### flick-vscode

- [protocol.ts:29-37](../flick-vscode/src/shared/protocol.ts#L29-L37) —
  add `outputSources?: Record<string, 'parameter' | 'capture' | 'toolOutput'>`
  to `BatchResult` (optional for back-compat with older servers).
- [api-client.ts:16-24](../flick-vscode/src/extension/api-client.ts#L16-L24) —
  add to `RawStepsResponse`.
- [controller.ts:391-398](../flick-vscode/src/extension/controller.ts#L391-L398) —
  pass `raw.outputSources` through.
- [main.ts:522-533](../flick-vscode/src/webview/main.ts#L522-L533) —
  replace the single OUTPUTS block with three labelled sections,
  ordered:

  1. **Captures** (what this run extracted from the page)
  2. **Tool Outputs** (what skills/tools returned)
  3. **Parameters** (session inputs — auto-collapsed once seen so they
     don't dominate the card. A `▸ Parameters (3)` summary clicks
     to expand.)

  Pair the sectioning with the **delta filter** discussed: only show
  Captures and Tool Outputs new vs. the previous batch's `outputs`.
  Parameters are stable for the life of a session — the auto-collapse
  rule handles their noise without delta logic.

### testbench-native

- Update Variables panel
  ([variables-view.ts](../testbench-native/src/extension/variables-view.ts),
  [testbench-runner.jsx](../testbench-native/src/webview/testbench-runner.jsx))
  to read `source` on `CaptureEvent` and visually distinguish
  `toolOutput` from `capture` (e.g., a small icon, italics, or a
  sub-group). Parameters already render distinctly because they arrive
  via `parametersResolved`.

### testbench-monaco

- Out of scope. It doesn't consume `capture` events today, so no change
  required. Could be updated later when there's other work in that
  variant.

## Backward compatibility

| Direction | Old → New | New → Old |
|---|---|---|
| Server response | Old server omits `outputSources`. New flick-vscode treats absent as "all sources unknown, render mixed" (or falls back to current single-block layout). | New server emits `outputSources`. Old flick-vscode ignores it. |
| `capture` event | Old emitter omits `source`. New consumer treats absent as `'capture'` (conservative). | New emitter sends `source`. Old consumer ignores it. |

No version flag needed. Both changes are purely additive.

## Test plan

### Server (unit + integration)

1. **`tests/api-server.test.ts`** — extend an existing fixture-driven
   test to assert `outputSources` is returned alongside `outputs`, with
   the expected source per key. Use a test that has all three:
   `## Parameters: user`, a `[output: pageTitle]` step, and a
   `[skill: ...]` invocation that aliases a value out.
2. **Per-source unit tests** — three small focused tests:
   - Parameter-only test → all keys labeled `'parameter'`.
   - `[output:]`-only test → all keys labeled `'capture'`.
   - Skill-with-outputs test → all keys labeled `'toolOutput'`.
3. **Collision test** — parameter and a same-named capture both present
   → label stays `'parameter'` (locks the decided behavior).
4. **SSE event test** — assert the two `capture` emit sites stream with
   the right `source` discriminator. Existing
   `tests/api-server-stepmode.test.ts` has the streaming harness
   pattern.

### Runner-core (protocol + consumer)

5. **`runner-core/tests/protocol.test.js`** — add a case for
   `CaptureEvent` with `source` to the narrowing helpers' test suite.
6. **Absent-source tolerance** — synthesize an old-server `capture`
   event without `source` and assert the consumer defaults to
   `'capture'` (no exception, sensible fallback).

### flick-vscode

7. **`flick-vscode/tests/fakes/fake-api-server.ts`** — extend the fake
   to return `outputSources` so controller tests can drive the new
   shape.
8. **`flick-vscode/tests/integration/controller.test.ts`** — assert the
   controller passes `outputSources` through to `historyReplace`. Two
   cases: server provides the field; server omits it (back-compat).
9. **Webview rendering test** — assert the three sections render only
   when non-empty, in the order Captures → Tool Outputs → Parameters,
   that Parameters are collapsed by default, and that the delta filter
   hides Capture/ToolOutput keys that didn't change vs. the previous
   batch.
10. **Live test** (`tests/vscode-live`) — optional. A real end-to-end
    with the live API server confirming all three source labels appear
    correctly for a test with a parameter, a capture, and a skill
    output.

### testbench-native

11. **Variables panel test** — feed `capture` events with
    `source: 'toolOutput'` and `source: 'capture'` through the existing
    webview suite and assert the rendered tree groups or annotates them
    correctly.

## Sequencing

Land in this order so each step is independently reviewable:

1. **Server-side source tracking** (write labels, emit `outputSources`
   in response, no streaming change yet). Lands first because
   everything else depends on it.
2. **Streaming `capture` event** gets the `source` field (server emit +
   runner-core protocol). Lands second.
3. **flick-vscode** consumes `outputSources` + delta filter + sectioned
   UI with Parameters auto-collapsed.
4. **testbench-native** Variables panel uses `source` (cosmetic; can
   ship later, independently).

Each step has its own commit + tests; each step keeps old clients
working unchanged.
