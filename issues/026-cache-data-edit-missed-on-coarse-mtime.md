# 026 — A data-file "save and re-run" within one mtime tick runs against the old data

**Status:** open / low-probability but silent (correctness)
**Area:** [src/server/project-bundle.ts](../src/server/project-bundle.ts) — `ProjectBundleResolver.resolve` (the reload gate), `inputMtimes` and `inputsUnchanged` (the comparison is `cur !== prev` on `mtimeMs` — **no size, no content hash**); [src/parser/interpolate-env-data.ts](../src/parser/interpolate-env-data.ts) (`interpolateEnvData`, which reads whatever bundle was resolved)
**Related:** [issues/011-env-bundle-cached-for-session-lifetime.md](011-env-bundle-cached-for-session-lifetime.md) (the bundle's reload trigger — this is its residual window)
**Opened:** 2026-06-03

This issue was first filed against the step cache, whose hash folded in the
resolved `${data.*}` values and so inherited the same stale bundle. The step
cache has since been removed. What is left is the underlying bundle problem,
which never depended on the cache.

## Summary

The server reloads a project's env/data bundle based on a file **mtime**
check. On a filesystem with coarse mtime resolution, or a very fast
"save → re-run" landing in the same clock tick as the previous load, the edited
file is **not reloaded**. The run then interpolates `${data.*}` and `${env.*}`
from the **stale** in-memory bundle, and the user's edit has no effect.

## Mechanism

1. `ProjectBundleResolver.resolve` reuses its cached bundle when
   `inputsUnchanged` says every input file's `mtimeMs` equals the recorded one —
   **pure `mtimeMs` equality, no size or content hash**. This is the mtime
   invalidation issue 011 proposed; it has since shipped as the per-project
   resolver cache, though 011's doc still describes the older "freeze for
   session" guard and remains open.
2. Step execution interpolates `${data.*}` / `${env.*}` against **that**
   bundle.
3. So if step 1 wrongly decides "unchanged", the step runs with the old value.

**Scope:** this affects the built-in `${env.*}` / `${data.*}` namespaces, which
come from the mtime-gated bundle. Named frontmatter `dataSources`
(`${<source>.X}`) are loaded **fresh per request** (deliberately not
bundle-cached), so they are **immune** to this same-tick window — only
`aiui.config.json`, `.env`, `.env.<name>` and `data/<name>.json` are exposed.

## Worked example

- `data/dev.json` = `{ "query": "laptops" }`. Run the test; the bundle loads
  and `Search for ${data.query}` resolves to `Search for laptops`.
- Within the same mtime tick (coarse-resolution FS, or a scripted edit+run),
  overwrite `data/dev.json` = `{ "query": "phones" }` and re-run.
- The mtime is unchanged (same tick) → bundle **not** reloaded → the step
  resolves to `Search for laptops` again. The user edited the data and saw no
  effect.

Tests that exercise the reload dodge this by `fs.utimes`-bumping the mtime,
which is why the window doesn't show up in CI — it's specifically the
*real-FS timing* case that's exposed.

## Impact

- **Low probability for human-paced editing** (a person rarely saves and re-runs
  inside one mtime tick, and human edits usually advance the mtime). But:
- **Higher for automation / scripts** that edit a data file and immediately
  re-run, and for **coarse-mtime filesystems** (some network mounts, older FATs,
  containers with reduced timer resolution).
- **Silent** when it triggers — indistinguishable from "the framework ignored my
  edit".

## Fix sketches

**Option A — content-hash the bundle inputs, not mtime.** Reload when a file's
**content hash** changes, independent of timestamps. Robust to coarse mtime and
same-tick edits. Cost: a read+hash of each input file per request — likely
negligible for typical `.env` and data files.

**Option B — watch the input files.** Use fs watch events to mark the bundle
dirty on write. Lowest per-request cost; more moving parts (watcher lifecycle,
missed events on some platforms).

**Option C — also compare size + mtime, and treat "same mtime" as "unknown →
reload" when the file was written very recently.** Cheap heuristic; narrows but
doesn't close the window.

**Recommended:** Option A, once the window is seen in practice.
[resolved/033](resolved/033-tool-edits-not-picked-up-until-server-restart.md)
weighed the same trade-off for tool files and kept mtime as the cheaper default
until then.

## Open questions

1. Are there real deployments on coarse-mtime filesystems (network shares,
   specific container runtimes) where this is more than theoretical?
2. Is per-request content-hashing of input files cheap enough at the sizes we
   expect, or do we need a size/mtime fast-path that only hashes on a
   "maybe changed" signal?

## Tests this would need

- Edit a data file's content **without advancing mtime** (set mtime back to the
  prior value via `utimes`), re-run, assert the new value is used.
- A no-op re-save (identical content, new mtime) does **not** needlessly
  reload (content-hash precision).
