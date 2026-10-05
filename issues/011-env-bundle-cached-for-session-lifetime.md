# 011 — Env / data bundle is cached for session lifetime; mid-session edits are invisible

**Status:** open / medium priority
**Area:** [src/server/session-manager.ts:809-817](../src/server/session-manager.ts#L809-L817) — `envBundle` lazy-init guard
**Related:** [src/env/resolve-bundle.ts](../src/env/resolve-bundle.ts) — `resolveEnvBundle`, [issues/010-resume-uses-line-numbers-not-step-ordinals.md](010-resume-uses-line-numbers-not-step-ordinals.md) — sister issue for the test-file resume path
**Opened:** 2026-05-18

## Summary

The API server loads `.env.<envName>` and `fixtures/data/<envName>.json`
once per session and caches them on `session.envBundle`. Subsequent
`/sessions/:id/steps` requests in the same session reuse the cached
bundle:

```typescript
// session-manager.ts
const requestedEnvName = request.envName?.trim();
if (requestedEnvName && !session.envBundle) {
  session.envBundle = await resolveEnvBundle({ envName: requestedEnvName });
}
const envDataCtx = session.envBundle
  ? { env: session.envBundle.env, data: session.envBundle.data, envName: session.envBundle.envName }
  : null;
```

The `!session.envBundle` guard means: load once, freeze for the session.
Edits to `.env.<envName>` or `data/<envName>.json` during a paused run
are not picked up until the user explicitly closes the session
(`steptix.restartSession`).

This is the same class of bug as [009 (skill cache)](#) — module-level
caching with no invalidation surface — but it's now the *only*
remaining instance of it in the pause-and-edit flow after the skill
cache fix.

## Why this hurts in practice

The most common workflow that hits this:

1. Test file references `${env.API_BASE_URL}` or `${data.user.email}`.
2. User runs the test, hits a breakpoint or pause partway through.
3. User realises the env var is wrong (typo, pointing at staging instead
   of local, etc).
4. User edits `.env.<envName>` and saves.
5. User clicks Continue.
6. Server interpolates `${env.API_BASE_URL}` against the **cached** bundle.
   The new value is invisible.
7. Step fails (or worse, succeeds against the wrong target). User has
   no signal that their edit didn't land.

The skill-cache version of this used to manifest as "my skill edit
didn't take effect." This one is sneakier because the substitution
happens silently inside `interpolateEnvData` — there's no log line saying
"using env from bundle loaded at timestamp T," so the user can't tell
the old value is in play.

## Asymmetry with what DOES re-read on Continue

After the recent fixes, these are re-read every batch (live):

- Test-file step text, `## Parameters`, `## Config` (client-side, from
  `editor.document.getText()`)
- Skill file bodies (server-side, after `clearSkillCache()` per request)
- `[store as: X]` captures persisted in `session.outputs`

These are still session-lifetime locked:

- `.env` / `.env.<envName>`
- `data/<envName>.json`
- AI configuration (model, gateway URL)
- Browser config (headed, viewport, baseUrl override)

For env/data the lock isn't load-bearing — it's a perf optimisation that
predates the pause-and-edit workflow. AI / browser configs are
genuinely session-shaped (you can't swap browser channels mid-run).

## Fix sketch

The skill-cache fix was a one-liner because the cache is module-level and
binary (clear all, repopulate on next access). Env is harder because
`resolveEnvBundle` has a side effect: `loadEnvFile` writes into
`process.env`. Calling it again doesn't un-set previously-loaded vars
that may have been deleted from the file in the meantime — dotenv
loaders typically *add* keys, not subtract.

So a proper invalidation needs to either:

1. **Track which keys came from which file.** When invalidating, delete
   the file's keys from `process.env` first, then re-load. Requires
   `loadEnvFile` to return the keys it set (small change).
2. **Snapshot process.env from BEFORE first env-file load,** and reset
   to that snapshot before re-loading. Avoids per-key tracking but
   means any unrelated writes to process.env between batches get blown
   away (probably acceptable — we don't write to process.env outside
   env loaders).
3. **Stop touching process.env at all.** Have the env loader return its
   parsed map without merging it into the global. Cleanest long-term —
   eliminates the side-effect class entirely — but a bigger refactor
   because all consumers of `process.env.X` would need to read from the
   new map instead.

For the `data/<envName>.json` half, invalidation is easy (pure file
read, no side effects). It could be done independently.

## Cost considerations

Skill cache invalidation is per-request because skill files are tiny.
Env / data files are typically larger (test fixtures with realistic
records). An mtime-based invalidation would be the middle ground:

```typescript
const stat = await fs.stat(envFilePath);
if (!session.envBundle || stat.mtimeMs > session.envBundleMtime) {
  session.envBundle = await resolveEnvBundle(...);
  session.envBundleMtime = stat.mtimeMs;
}
```

Buys correctness without paying for re-parse on every batch.

## Tests this would need

- Start a session with `envName=dev`, run a step that interpolates
  `${env.API_BASE_URL}`, pause.
- Modify `.env.dev` on disk to change `API_BASE_URL`.
- Continue. The next interpolation must use the new value.
- Same for `data/<envName>.json`.
- Negative: editing some unrelated key in `.env.dev` doesn't trip the
  invalidation mid-flight in a way that breaks running steps (only
  matters if we go with mtime-based; per-request clear is unconditional).
- Removing a key entirely from the file → the key is gone from
  subsequent interpolations (only works under fix sketches 1 or 2).

## Discovered while

Auditing the pause-and-resume flow alongside [010](010-resume-uses-line-numbers-not-step-ordinals.md).
The skill cache fix
([1c7ed42 / 0.5.23 / 0.5.24](#)) covered the most common case;
this is the remaining gap for env/data-bound values. Flagged here so
the next pass at "make pause-and-resume bulletproof" can decide
whether to ship it together with 010 or hold for a user report.

## Revisit when

- A user reports "I changed my .env and Continue didn't pick it up."
- A "switch env mid-session" feature is added (the `restartSession`
  workaround stops being acceptable).
- Pause-and-edit graduates to a documented workflow alongside
  paused-on-error.
