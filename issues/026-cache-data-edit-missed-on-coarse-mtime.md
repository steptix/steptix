# 026 — Step cache: a data-file "save and re-run" within one mtime tick replays stale data (018's efficacy depends on 011's reload trigger)

**Status:** open / low-probability but silent (correctness)
**Area:** [src/server/session-manager.ts:1548-1556](../src/server/session-manager.ts#L1548) (018's hash interpolation — only as fresh as the loaded bundle), [src/server/session-manager.ts:616](../src/server/session-manager.ts#L616) (the reload gate) + [session-manager.ts:707-718](../src/server/session-manager.ts#L707) (`bundleInputsUnchanged`; the comparison at [:715](../src/server/session-manager.ts#L715) is `cur !== prev` on `mtimeMs` — **no size, no content hash**), [src/parser/interpolate-env-data.ts:53-92](../src/parser/interpolate-env-data.ts#L53)
**Related:** [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md) (the root cause — the bundle's reload trigger), [issues/018-step-cache-blind-to-data-file-value-changes.md](018-step-cache-blind-to-data-file-value-changes.md) (the fix this undermines; names this exact caveat in its Follow-ups), [issues/025-cache-hash-blind-to-data-outside-step-text.md](025-cache-hash-blind-to-data-outside-step-text.md)
**Opened:** 2026-06-03

## Summary

Issue 018's fix — fold resolved `${data.*}` values into the bundle hash so a
data edit busts the cache — is only as accurate as the **data the server has
loaded**. The server reloads a project's data bundle based on a file
**mtime** check (issue 011). On a filesystem with coarse mtime resolution (or a
very fast "save → re-run" landing in the same clock tick as the previous load),
the edited file is **not reloaded**, the hash is computed from the **stale**
in-memory data, the hash is unchanged, and the cache replays the old value — the
exact bug 018 set out to fix.

## Mechanism

1. Bundle reload is gated on an mtime comparison
   ([session-manager.ts:616](../src/server/session-manager.ts#L616) calls
   `bundleInputsUnchanged`, which compares `(await stat(p)).mtimeMs` with
   `cur !== prev` at [:715](../src/server/session-manager.ts#L715) — **pure
   `mtimeMs` equality, no size or content hash**). If the recorded `mtimeMs`
   equals the current one, the file is considered unchanged and the cached parse
   is reused. (This is the mtime invalidation issue 011 *proposed*; it has since
   shipped as a per-project `projectBundleCache`, though 011's doc still describes
   the older "freeze for session" guard and remains open.)
2. 018 interpolates `${data.*}` into the hash source using **that** loaded data
   ([session-manager.ts:1549](../src/server/session-manager.ts#L1549)).
3. So if step 1 wrongly decides "unchanged", step 2 hashes stale values → the
   hash doesn't move → `StepCache.initialize` keeps the entry → stale replay.

The hazard is the composition: 018 is correct *given* a fresh bundle; 011 doesn't
always deliver one.

**Scope:** this affects the built-in `${env.*}` / `${data.*}` namespaces, which
come from the mtime-gated bundle. Named frontmatter `dataSources` (`${<source>.X}`)
are loaded **fresh per request** ([session-manager.ts:1320-1321](../src/server/session-manager.ts#L1320),
deliberately not bundle-cached), so they are **immune** to this same-tick window —
only the default `data/<env>.json` and `.env*` files are exposed.

## Worked example

- `data/dev.json` = `{ "query": "laptops" }`. Run the test (cache on); the bundle
  loads, hash source resolves to `Search for laptops`, plan cached.
- Within the same mtime tick (coarse-resolution FS, or a scripted edit+run),
  overwrite `data/dev.json` = `{ "query": "phones" }` and re-run.
- The mtime is unchanged (same tick) → bundle **not** reloaded → 018 interpolates
  the **stale** `laptops` → hash unchanged → cache HIT → the AI's `laptops` plan
  replays. The user edited the data and saw no effect — 018's reported symptom,
  resurrected through the back door.

(018's own regression tests dodge this by `fs.utimes`-bumping the mtime, which is
why the bug doesn't show up in CI — it's specifically the *real-FS timing* case
that's exposed.)

## Impact

- **Low probability for human-paced editing** (a person rarely saves and re-runs
  inside one mtime tick, and human edits usually advance the mtime). But:
- **Higher for automation / scripts** that edit a data file and immediately
  re-run, and for **coarse-mtime filesystems** (some network mounts, older FATs,
  containers with reduced timer resolution).
- **Silent** when it triggers — indistinguishable from "the framework ignored my
  edit".

## Fix sketches

This is fundamentally [011](011-env-bundle-cached-for-session-lifetime.md)'s
reload trigger; the fix belongs there but is motivated by the cache.

**Option A — content-hash the bundle, not mtime.** Reload when the file's
**content hash** changes, independent of timestamps. Robust to coarse mtime and
same-tick edits. Cost: a read+hash of referenced data files per request (already
read on a cold miss; the extra is hashing on every request — likely negligible
for typical data files).

**Option B — watch the data files.** Use fs watch events to mark the bundle
dirty on write. Lowest per-request cost; more moving parts (watcher lifecycle,
missed events on some platforms).

**Option C — also compare size + mtime, and treat "same mtime" as "unknown →
reload" when the file was written very recently.** Cheap heuristic; narrows but
doesn't close the window.

**Option D (cache-local backstop) — fold a content hash of referenced data files
into `meta.json` directly** (this is also [025](025-cache-hash-blind-to-data-outside-step-text.md)'s
Option A). Then the cache busts on a content change even if the *bundle* didn't
reload — decoupling cache correctness from 011's trigger entirely. Most robust
for the cache specifically; doesn't fix 011's other consumers.

**Recommended:** Option A (content-hash reload in 011) as the systemic fix; if
011 can't be touched soon, Option D gives the cache its own correctness
independent of the bundle's staleness.

## Open questions

1. ~~What is 011's exact current trigger — `mtimeMs` equality only, or
   mtime+size?~~ **Answered:** pure `mtimeMs` equality, no size or content
   component ([session-manager.ts:698/711/715](../src/server/session-manager.ts#L715)).
   The window is as wide as feared.
2. Are there real deployments on coarse-mtime filesystems (network shares,
   specific container runtimes) where this is more than theoretical?
3. Is per-request content-hashing of data files cheap enough at the data-file
   sizes we expect, or do we need a size/mtime fast-path that only hashes on a
   "maybe changed" signal?
4. Should the cache decouple from 011 entirely (Option D) regardless, so cache
   correctness doesn't ride on a shared bundle's reload policy?

## Tests this would need

- Edit a data file's content **without advancing mtime** (set mtime back to the
  prior value via `utimes`), re-run, assert the cache is busted and the new value
  is used. (The inverse of the trick 018's tests use — here we *pin* mtime and
  prove content still wins.)
- A no-op re-save (identical content, new mtime) does **not** needlessly bust the
  cache (content-hash precision).
