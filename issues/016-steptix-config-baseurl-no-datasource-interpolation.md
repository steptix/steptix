# 016 — Steptix can't use `${data.X}` / `${env.X}` / named dataSources in `## Config` (baseUrl/timeout)

**Status:** open / medium priority
**Area:** [steptix-vscode/src/extension/run-controller.ts:1461-1465](../steptix-vscode/src/extension/run-controller.ts#L1461-L1465) — client-side `resolveValue`; [run-controller.ts:927-931](../steptix-vscode/src/extension/run-controller.ts#L927-L931) — where `## Config` baseUrl/timeout is resolved before the session is created
**Related:** [src/parser/markdown.ts:192-196](../src/parser/markdown.ts#L192-L196) — the CLI reference impl that DOES interpolate config; [src/server/session-manager.ts:768-770](../src/server/session-manager.ts#L768-L770) — server navigates to client-supplied baseUrl; [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md) — sister "config is resolved client-side from `editor.document.getText()`" note
**Opened:** 2026-05-28

## Summary

In a test's `## Config` section, the CLI run path resolves `baseUrl` (and
`timeout`) from any of `${env.X}`, `${data.X.Y}`, or a named dataSource
`${source.X.Y}`. The Steptix (VS Code extension) run path does **not** — it
only resolves a bare `$ENV_VAR` against the flat `.env` map. So this:

```markdown
## Config
- baseUrl: ${data.baseUrl}
```

works under `steptix run … --env local` but, in the Steptix, is sent to the
server **verbatim** as the literal string `${data.baseUrl}`, and the browser
navigates to that bogus URL.

The asymmetry is surprising because **steps** in the same file *do* resolve
`${data.X}` / `${env.X}` in the Steptix (that pass runs server-side). It's
only the `## Config` values that diverge.

## Root cause

`baseUrl`/`timeout` must be known *before* the session is created — the
server launches the browser and navigates to `baseUrl` up front
([session-manager.ts:768-770](../src/server/session-manager.ts#L768-L770)),
and the server is deliberately schema-agnostic about config
([session-manager.ts:41-43](../src/server/session-manager.ts#L41-L43)): it
navigates to whatever the client sent and never interpolates config itself.

So the extension resolves config client-side, before any server round-trip,
using a minimal resolver:

```typescript
// run-controller.ts:1461-1465
function resolveValue(value: string, env: Record<string, string>): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  return env[name] ?? value;   // flat lookup; no braces, no dots, no data
}
```

`env` here is just the parsed `.env` file
([run-controller.ts:650/857](../steptix-vscode/src/extension/run-controller.ts#L650)).
This handles `$STAGING_URL` but not `${env.STAGING_URL}` (braces), not
`${data.baseUrl}` (the env-default JSON), and not `${endpoints.app.url}`
(a named dataSource). Those forms fall through and are sent as literals.

Meanwhile the CLI path resolves config correctly because
`applyEnvDataInterpolation` walks every config string through the full
`interpolateEnvData` (env + data + named sources):

```typescript
// markdown.ts:192-196  — the behaviour we want to match
const cfg = parsed.config as Record<string, string | undefined>;
for (const [k, v] of Object.entries(cfg)) {
  if (typeof v === 'string') cfg[k] = interpolateEnvData(v, ctx);
}
```

## Why this hurts in practice

Per-environment base URLs are the single most common reason to reach for
dataSources at all. A user who writes `baseUrl: ${data.baseUrl}` (the form
shown in our own data-source docs/fixtures) and runs it in the Steptix gets
a silent navigation to the literal `${data.baseUrl}` — no error at config
time, just a wrong/blank page and confusing step failures. The workaround
(a flat `$ENV_VAR` from `.env.<name>`) works but is undiscoverable and
inconsistent with how steps behave in the very same file.

## Fix sketches

The constraint is that config is needed *before* the session exists, so the
data/env bundle has to be available client-side at that point, or the
resolution has to move server-side into session creation.

1. **Resolve config client-side against the full bundle.** Teach the
   extension to load the same env+data the server would (the env-default
   `fixtures/data/<envName>.json` and named dataSources from frontmatter) and
   run a brace-aware `${env.X}`/`${data.X}`/`${source.X}` substitution over
   config before building `sessionConfig`. Pro: no protocol change, matches
   CLI semantics exactly. Con: duplicates a slice of the env/data loader in
   the extension (the extension currently only reads `.env`), and the
   data-dir / `steptix.config.json` resolution has to be mirrored client-side.

2. **Move config interpolation server-side.** Have the client send raw
   config strings + `envName`; the server resolves config against the bundle
   it already builds (`resolveEnvBundle`) during `createSession`, then
   navigates. Pro: single source of truth, no loader duplication, named
   sources come along for free if the server learns to load test-level
   dataSources (today it doesn't — see the env-bundle scope). Con: protocol
   change; the server stops being schema-agnostic about config; ordering —
   the bundle must be resolved before the browser navigates (today the env
   bundle is lazy-loaded on the first *steps* request, AFTER session create).

3. **Minimal: brace-aware `${env.X}` only.** Extend `resolveValue` to accept
   `${env.NAME}` / `$NAME` / `${NAME}` forms against the `.env` map, but not
   `data`/named sources. Pro: tiny, unblocks the most common case if users
   are willing to put the URL in `.env`. Con: still diverges from the CLI for
   `${data.X}` — doesn't actually satisfy the request ("`baseUrl:
   ${data.baseUrl}`"). Probably only a stopgap.

Sketch 2 is the most correct (one interpolation path, server-owned) but is
the bigger change and interacts with the lazy env-bundle init in
[011](011-env-bundle-cached-for-session-lifetime.md) and the test-level
dataSource scope gap. Sketch 1 is self-contained in the extension and
ships independently.

## Tests this would need

- Extension/integration: a test with `## Config` `baseUrl: ${data.baseUrl}`
  run via the Steptix against env `local` creates a session whose
  `sessionConfig.baseUrl` is the resolved value, not the literal.
- Same for `${env.X}` (brace form) and a named `${source.X.Y}`.
- Regression: a literal `baseUrl: https://…` and a flat `$ENV_VAR` still
  resolve as today.
- Negative: an unresolved/missing key surfaces a visible error at config
  time instead of silently navigating to a `${…}` literal.
- Parity check: the resolved `sessionConfig.baseUrl` matches what the CLI
  path produces for the same file + env.

## Discovered while

Answering a user question about whether `baseUrl` can be sourced from a
dataSource. It can on the CLI; it can't in the Steptix. The user asked to
fix the Steptix so `baseUrl: ${data.baseUrl}` works there too.

## Workaround until fixed

- Use a flat env var: `STAGING_URL=…` in `.env.<name>`, then
  `baseUrl: $STAGING_URL` (resolves client-side today), **or**
- Drop `## Config` baseUrl and navigate explicitly in step 1
  ("Navigate to `${data.baseUrl}`…") — steps are interpolated server-side and
  already resolve `${data.X}` / `${env.X}`. Trade-off: no relative-URL base,
  no baseUrl in the report header.

## Revisit when

- This is picked up for implementation (user has asked for it).
- Sketch 2 is considered alongside [011](011-env-bundle-cached-for-session-lifetime.md)
  and the test-level dataSource server-scope gap, since all three touch how
  the server builds and times the env/data bundle.
