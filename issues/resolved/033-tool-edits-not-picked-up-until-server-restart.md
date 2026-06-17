# 033 — Tool-file edits (and new files) aren't picked up until server restart (catalogue cache + ESM import cache + one-shot file index)

**Status:** ✅ **RESOLVED — implemented + tested (2026-06-18).** See [Implemented](#implemented-2026-06-18). esbuild bundle-per-reload (Part 1) + per-run re-index (Part 2) shipped; server loads the catalogue with `{ reload: true }`. The spike's `node_modules/.cache` temp-module location was **corrected during implementation** (it breaks package self-reference) to a dot-dir co-located in the tools dir; the step-into sourcemap follow-up was fixed (`absWorkingDir`). The original `?t=<mtime>` remedy was disproven earlier — see [Verification](#verification-2026-06-17) / [Spike outcome](#spike-outcome-2026-06-18).
**Area:** [src/tools/registry.ts:126-147](../../src/tools/registry.ts#L126) (`resolve` — short-circuits on `byFile.has(abs)`), [src/tools/registry.ts:150-172](../../src/tools/registry.ts#L150) (`loadFile`), [src/tools/registry.ts:364-392](../../src/tools/registry.ts#L364) (`importToolFile` — `import(pathToFileURL(filePath).href)`), [src/server/session-manager.ts:1477-1490](../../src/server/session-manager.ts#L1477) (the reload gate `needsCatalogueLoad`)
**Related:** [issues/011-env-bundle-cached-for-session-lifetime.md](../011-env-bundle-cached-for-session-lifetime.md) (same class — session-lifetime cache with no edit-invalidation surface; skill cache was the first instance, fixed via `clearSkillCache()`), [issues/026-cache-data-edit-missed-on-coarse-mtime.md](../026-cache-data-edit-missed-on-coarse-mtime.md) (mtime-coarseness caveat that applies to the proposed fix's trigger), [stories/lazy-tool-loading.md](../../stories/lazy-tool-loading.md) (the lazy-load design this builds on)
**Opened:** 2026-06-17

## Summary

When the long-lived API server (`serve` / TestBench) is running, two tool-authoring
edits don't take effect until a full server restart:

- **(A) Editing an existing tool file** in `tests.toolsDir` and re-running a
  `[tool: …]` step **executes the old code**.
- **(B) Adding a brand-new tool file** mid-session and referencing it yields
  **"tool not found"** — the file is never discovered.

The CLI runner (`aiui run`) is unaffected by both because it is a one-shot
process. There are **three** distinct staleness vectors, two behind (A) and one
behind (B); a complete fix must address all three.

Symptom (A) — *stale code for an edited file* — is kept alive by two caches, and
**both** must be addressed (fixing either alone is insufficient):

1. **The per-session tool catalogue** (`ManagedSession.toolCatalogue`). Built
   once and reused across batches; `resolve` short-circuits on `byFile.has(abs)`
   so a file that's already been loaded is never re-imported.
2. **Node's ESM module registry.** `importToolFile` does
   `await import(pathToFileURL(filePath).href)`, and Node caches ESM modules by
   URL for the lifetime of the process. The same URL returns the same module
   object — the file is never re-read or re-transpiled (by tsx) — so even a
   fresh catalogue calling `import()` on the same path gets the stale module.

Symptom (B) — *a new file is undiscoverable* — has a third cause:

3. **The file index is built once.** `loadToolCatalogue` walks the dir and fills
   `fileIndex` (`rel-path → abs-path`) a single time; the server only re-walks
   when `indexedCount === 0` ([the reload gate](../../src/server/session-manager.ts#L1478)).
   A file added after the first run with a populated dir is never indexed, so
   `resolve` falls through to the directly-registered lookup and throws
   "not found" ([registry.ts:143-146](../../src/tools/registry.ts#L143)). (Deleting
   a file has the dual problem: its stale index entry lingers.)

The CLI runner even documents cache #2 as a feature:
[test-runner.ts:255-258](../../src/runner/test-runner.ts#L255) — *"Load the tool
catalogue once per test. Node caches dynamic imports so subsequent loads are
cheap."* That's correct for a one-shot process; it's a trap for a long-lived one.

## Mechanism

How tools load today (see [stories/lazy-tool-loading.md](../../stories/lazy-tool-loading.md)):

1. `loadToolCatalogue(dir)` ([registry.ts:291](../../src/tools/registry.ts#L291))
   walks the dir and builds a lazy **file index** (`rel-path → abs-path`).
   It imports nothing.
2. At invocation, `executeToolStep` calls
   `catalogue.resolve(ref)` ([registry.ts:126](../../src/tools/registry.ts#L126)).
   If the file isn't in `byFile` yet, `resolve` calls `loadFile(abs)` →
   `importToolFile(abs)` → `import(fileURL)`. The result is cached in `byFile`.
3. Every later reference to that file is a `byFile` map hit
   ([registry.ts:131](../../src/tools/registry.ts#L131)) — no re-import.

On the server, the catalogue itself is reused across runs. The reload gate
([session-manager.ts:1478](../../src/server/session-manager.ts#L1478)) rebuilds
`session.toolCatalogue` only when:

- there is no cached catalogue, **or**
- `request.toolsDir` differs from `toolCatalogueDir` (the dir changed), **or**
- `cachedCatalogue.indexedCount === 0` (the dir was missing/empty last scan).

A normal, populated, unchanged `toolsDir` hits none of these, so:

- **Cache #1:** the catalogue (and its `byFile`) survives across runs → `resolve`
  is a map hit → `loadFile`/`import()` never re-runs.
- **Cache #2:** even if we forced a rebuild (`loadToolCatalogue` re-indexes but
  imports nothing), the subsequent `resolve` → `import(sameURL)` still returns
  the **cached module** from Node's registry. Re-indexing alone changes nothing.

So an edit to `print_all.ts` lands on disk, but the running server keeps the old
behaviour until restart.

For the **new-file** case, the gate is the third clause: with a populated dir,
`indexedCount > 0` and `toolsDir` unchanged, so the gate never re-walks the dir.
A file created after that first scan is absent from `fileIndex`; `resolve` finds
no `abs`, falls to the directly-registered lookup (empty for disk catalogues),
and throws the "not found" diagnostic — even though the file is sitting on disk.

## Not the `dist/` rebuild case

A natural first guess is the "rebuild `dist/` after editing `src/`" rule
(memory; applies to the framework's own compiled output). That is **not** what's
happening here. Tool files under `tests.toolsDir` are `.ts` imported **directly**
via tsx (`--import tsx`; `TOOL_FILE_EXTS` includes `.ts`,
[registry.ts:253](../../src/tools/registry.ts#L253)). Editing the tool `.ts` on
disk *is* sufficient — there is no compile step for user tool files. The only
thing blocking the edit from taking effect is the import cache, not a missing
build.

## Worked example

1. `tools/src/greet.ts` logs `"hello"`. Start a TestBench session, run a
   `[tool: greet]` step → log shows `hello`.
2. Edit `greet.ts` to log `"hi"`, save.
3. Re-run the step **on the same session** (Continue / re-run, no restart).
4. Observed: log still shows `hello`. Expected: `hi`.
5. Restart the server, re-run → `hi`. (Confirms it's the process-lifetime cache,
   not the file on disk.)

## Impact

- **Constant friction when authoring tools through TestBench.** Every tool edit
  needs a server restart to verify — the tightest, most frequent loop in tool
  development.
- **Silent.** Same failure-signature as "the framework ignored my edit" — no log
  line says "tool loaded from cache at time T", so the stale run looks like a
  logic bug in the freshly-edited code.
- **Not a report-correctness bug.** The run faithfully reports what the (stale)
  code did; nothing is mis-recorded. This is a staleness/DX issue, which is why
  it's medium, not high.

## Fix

The fix has two parts, mapping to the two symptoms: **Part 1** re-imports an
**edited** file (A); **Part 2** re-discovers **added/removed** files (B). Both
sit in [registry.ts](../../src/tools/registry.ts); Part 2 also flips one branch of
the server reload gate.

### Part 1 — re-import edited files (mtime-aware lazy load)

> **⚠ The `?t=` cache-bust below was DISPROVEN; mechanism now RESOLVED.** Appending
> `?t=<mtime>` to a `.ts` import URL does **not** force tsx to re-transpile (it
> caches by path, in memory — see [Verification](#verification-2026-06-17)). The
> *structure* of Part 1 (detect a changed file, re-load it) is right; the working
> re-transpile mechanism is **esbuild bundle-per-reload**, established by the
> [Spike outcome](#spike-outcome-2026-06-18). Step 3 below is updated accordingly.

The shape of the fix: detect a changed tool (entry or a bundled helper) and
re-import it via a mechanism that actually re-transpiles.

1. Record a **change signature** per loaded file. The entry's `mtimeMs` is the
   floor, but because helpers are bundled in (step 3), the real signature is over
   the bundle's *input set* — use esbuild's `metafile` inputs (mtime or hash of
   each) so a **helper** edit also counts as "changed".
2. In `resolve`, after locating `abs`, compare the current signature to the
   recorded one; re-run `loadFile(abs)` when the file is unloaded **or** the
   signature changed (replacing the current "load once" `!byFile.has(abs)` guard).
3. In `loadFile`/`importToolFile`, replace the direct `import(pathToFileURL(...))`
   with **esbuild bundle-per-reload** (proven — [Spike outcome](#spike-outcome-2026-06-18)):
   `esbuild.build({ bundle:true, format:'esm', platform:'node',
   packages:'external', write:false, sourcemap:'inline' })`, write the output to a
   content-hashed temp `.mjs` under `<projectRoot>/node_modules/.cache/aiui-tools/`,
   `import()` it, delete the temp file, then finalise its exports as today. Keep
   `RegisteredTool.filePath` pointing at the original `.ts`.

This stays lazy (only a file referenced *again* **and** actually changed is
rebundled — steady-state is one signature check + a map hit; ~20 ms only on an
actual edit) and leaves the CLI unchanged (one-shot; keep its direct import).

### Part 2 — re-discover added/removed files (re-index per run)

The file index is built once, so Part 1 alone never sees a file that didn't
exist at first scan. Refresh the index when the dir is unchanged instead of
skipping:

1. Add `ToolCatalogue.refreshIndex()` — re-walk the scanned dir (via the
   existing `listToolFiles`), then reconcile `fileIndex`:
   - **add** newly-discovered files;
   - **drop** files no longer on disk **and evict their `byFile` entry** (so a
     reference to a deleted tool gives the clean "not found" diagnostic rather
     than an import error, and a delete-then-recreate re-imports fresh);
   - leave `byFile` for surviving files alone (Part 1's mtime check handles their
     edits); refresh `diagnostics.filesScanned`.

   Three correctness requirements the reviewer surfaced (all must hold):
   - **`diagnostics` may be undefined.** It's optional and only set by
     `loadToolCatalogue`, *not* by a directly-constructed `new ToolCatalogue()` +
     `register(...)` (the programmatic path `resolve` still supports,
     [registry.ts:143-146](../../src/tools/registry.ts#L143)). So don't key the
     re-walk off `diagnostics.toolsDir` — store the scanned dir in a dedicated
     field, and make `refreshIndex()` a **no-op when there's no scanned dir**.
   - **Handle a now-missing / not-a-directory dir.** `listToolFiles` →
     `fs.readdir` throws ENOENT/ENOTDIR if the dir was deleted/replaced
     mid-session. `refreshIndex()` must replicate `loadToolCatalogue`'s
     existence + `isDirectory` handling (set `toolsDirMissing`, clear
     `fileIndex`, empty `byFile`) and the gate must wrap the call in the existing
     try/catch ([session-manager.ts:1488-1507](../../src/server/session-manager.ts#L1488))
     so a mid-run `rmdir` doesn't crash the batch.
   - **Maintain *all* of `diagnostics`, not just `filesScanned`.** A dir that was
     missing at first scan (`toolsDirMissing === true`) and is later created must
     have that flag cleared on refresh — otherwise the not-found hint keeps
     rendering "tools.dir does not exist" ([registry.ts:214-220](../../src/tools/registry.ts#L214))
     for a dir that now exists. (Given this, prefer keeping the gate's
     `indexedCount === 0` clause as a *full* `loadToolCatalogue` and only routing
     the `indexedCount > 0 && unchanged-dir` case through `refreshIndex()` — less
     surface for the equivalence to drift.)
2. In the server reload gate
   ([session-manager.ts:1478](../../src/server/session-manager.ts#L1478)): when
   `request.toolsDir` is set **and equals** `toolCatalogueDir` (dir unchanged),
   call `await session.toolCatalogue.refreshIndex()` instead of no-op-ing. A
   *changed* dir still does a full `loadToolCatalogue` (fresh instance); the
   `indexedCount === 0` branch is subsumed (a previously-empty dir now gets
   re-walked every run regardless).

Net: every server run re-walks the dir (index-only — **no imports**, O(files)
`readdir`), so new files appear, deleted files disappear, and edits re-import via
Part 1 — all while `byFile` survives across runs for unchanged tools. The
**earlier "no session-manager change needed" framing no longer holds** — Part 2
deliberately touches the gate (the registry-only alternative is the resolve-miss
re-scan below).

**Simpler variant (drop Part 1's mtime-resolve logic) — REJECTED.** The idea was
to rebuild `byFile` each run and rely **solely** on `?t=<mtimeMs>` to dedupe at
the ESM layer (unchanged file → same URL → cache hit; changed file → new URL →
re-transpile). Since `?t=` busting is disproven under tsx
([Verification](#verification-2026-06-17)), this variant has **no working
invalidation at all** — it leans 100% on the mechanism that fails, and removes
even the re-`loadFile` attempt the persistent-`byFile` design makes. It is
strictly worse than Part 1, not "simpler-but-equivalent". Keep it only as a
record of a path not to take.

**Alternatives considered:**

- **Resolve-miss re-scan (registry-only Part 2).** Instead of re-indexing every
  run, re-walk the dir *once* when `resolve` finds no `abs` for a ref, then
  retry before throwing "not found". Keeps the fix entirely in the registry (no
  gate change) and pays the walk only on a miss — but a misspelled/genuinely
  missing tool referenced in a loop re-walks each time, and it never notices a
  *deleted* file (a hit short-circuits before the rescan). Could complement the
  per-run refresh rather than replace it.
- **Content-hash trigger instead of mtime (Part 1).** Robust to coarse-mtime
  filesystems and same-tick "save → re-run" edits (the exact hazard
  [026](../026-cache-data-edit-missed-on-coarse-mtime.md) documents for the data
  bundle). Cost: a read+hash of each referenced tool file per resolve. Use this
  if mtime proves too coarse in practice; mtime is the cheaper default.
- **`fs.watch` the `toolsDir`** to mark files dirty / index new files on write
  events. Lowest per-run cost (no walk), covers both A and B; more moving parts
  (watcher lifecycle, missed-event platforms, Windows recursive-watch quirks).
  Overkill for the current need but the "proper" long-term shape if tool dirs
  grow large.
- **Gate behind a `dev`/watch flag** so a production `serve` keeps the pure
  cached path (no per-run walk, no re-stat). Probably unnecessary (the costs are
  trivial and `serve` is fundamentally a dev tool), but available if we want zero
  behaviour change in prod.

## Verification (2026-06-17)

A reviewer flagged Part 1's cache-bust as unproven; it was then tested directly
with throwaway in-process probes (`node --import tsx`) on the installed
toolchain — **tsx 4.21.0, Node v22.22.0**. Results:

| Probe | Result |
|---|---|
| Import `.ts`, edit on disk, re-import with a **fresh `?t=` query** (same process) | **STALE** — returned the pre-edit value. tsx serves its path-keyed transpile cache and ignores the query. |
| Same pattern on a plain **`.mjs`** (no TS transform) | **FRESH** — `?t=` busting works. So it's *tsx's transform layer*, not Node's resolver, that ignores the query. |
| `tsImport()` from `tsx/esm/api`, two calls across an edit (with and without query) | **STALE** across calls; also returns exports wrapped under a `.default` namespace (awkward interop). |

Conclusion: the `?t=<mtime>` mechanism in Part 1 step 3 **cannot work** for `.ts`
tool files under tsx, and the trivial `tsImport()` swap doesn't either. A
namespaced `register()` (fresh namespace per reload) remains the most likely
in-process path but is unproven and carries the wrapper/interop + per-reload
hook-registration costs noted above. **This is the gate on the whole fix** —
spike a working re-transpile mechanism (and write the end-to-end "edit → re-run
on same session → see new behaviour" test against it) *before* building the
`refreshIndex`/gate scaffolding.

(Probes were deleted after running; the registry's own
[tool-registry.test.ts](../../tests/tool-registry.test.ts) corroborates the
same-path import-cache behaviour — it deliberately varies the temp-dir path per
test because re-importing the same path cache-hits.)

## Spike outcome (2026-06-18)

A focused spike (10 throwaway in-process probes, `node --import tsx`, tsx 4.21.0
/ Node 22.22 / esbuild 0.27.7) searched for a mechanism that re-transpiles an
edited `.ts` tool in-process. Results:

| Mechanism | Result |
|---|---|
| `import(url + '?t=<mtime>')` | **STALE.** `onImport` shows the query *is* preserved, so Node re-invokes the loader — but tsx returns its **path-keyed in-memory transpile cache**, so you get a fresh module *instance* of *stale source*. |
| `tsImport()` (`tsx/esm/api`) | **STALE** across calls; also wraps exports under `.default`. |
| `register({ namespace })`, fresh namespace per reload | **STALE.** `onImport` shows an identical module URL regardless of namespace — the namespace doesn't vary module identity for re-evaluation. |
| `TSX_DISABLE_CACHE=1` (with any of the above) | **STALE.** Only affects tsx's on-disk cache, not the in-memory transpile cache that matters here. |
| Unique file **path** per reload (copy `mod.ts`→`reload-N.ts`) | Entry **reloads**; a **relative helper stays STALE** (its path is unchanged → still cache-hits). |
| **esbuild bundle-per-reload → import a unique temp `.mjs`** | ✅ **Entry + relative helper both reload.** Realistic tool (`import { defineTool } from 'ai-ui-automation/tools'` + `export default defineTool({...})`) reloads: self-import resolves, `finaliseToolExport` accepts the bundled default, edits to `description`/`run()` are picked up. **~20 ms warm** (37 ms cold incl. esbuild service spawn). Temp file deletable immediately post-import. |

**Root cause, nailed:** tsx caches transpile output keyed by **file path, in
memory**, and nothing public (query string, namespace, `TSX_DISABLE_CACHE`)
busts it. Only a genuinely distinct path yields a fresh transpile — and that
alone misses relative helpers, whose paths don't change.

**Recommended mechanism: esbuild bundle-per-reload.** It's the only candidate
that reloads the *whole* tool (entry + helpers), it's in-process (so the live
Playwright `page` handle is preserved — a worker/subprocess can't receive it),
and esbuild is already on disk as a tsx dependency (directly resolvable). Shape:

1. On a reload (gated — see below), `esbuild.build({ entryPoints: [toolFile],
   bundle: true, format: 'esm', platform: 'node', packages: 'external',
   write: false, sourcemap: 'inline' })`. `bundle:true` inlines relative
   helpers fresh; `packages:'external'` leaves bare deps (`ai-ui-automation/tools`,
   playwright, …) to be resolved by Node at import time (fast, no native-dep
   bundling).
2. Write the bundled output to a **unique** temp `.mjs` *under the project root*
   — e.g. `<projectRoot>/node_modules/.cache/aiui-tools/<contentHash>.mjs`. Under
   project root so the externalized self-import `ai-ui-automation/tools` resolves
   (Node self-referencing via the package `exports` → `dist/tools/index.js`);
   under `node_modules/.cache` so the catalogue's dir-walk never indexes it.
3. `await import()` it, then delete the temp file (import has already read it).
   Run the existing `finaliseToolExport` on `mod.default` / named exports exactly
   as `importToolFile` does today.

**Implementation decisions this settles:**
- **Gate the rebundle on change.** esbuild's `metafile` lists every bundled input
  → hash/mtime those to skip rebundling unchanged tools (steady-state cost: 0).
  The metafile *also* gives the helper dependency list for free, so helper edits
  trigger a rebundle too.
- **Dedupe by content hash.** Key the temp `.mjs` by a hash of the bundle output;
  identical output reuses the prior import URL. This bounds Node-ESM-registry
  growth to *distinct* tool versions, not edits (there's no evict API).
- **Keep `RegisteredTool.filePath` = the original `.ts`** (for error messages and
  the step-into debugger), never the temp `.mjs`.
- **CLI stays as-is.** It's one-shot; only the long-lived server needs reload.
  Confines the new path to the server (or behind a dev flag), minimizing
  divergence.

**Open follow-up (validate during implementation, not a blocker):** the
`tool:awaiting-debugger` / step-into path ([session-manager.ts:2237-2249](../../src/server/session-manager.ts#L2237))
runs a `debugger;` and relies on the tool's source location. With bundling, the
*executing* module is the temp `.mjs`. `sourcemap: 'inline'` should map V8's
breakpoint back to the original `.ts`, but this needs an actual inspector-attach
test — it's the one place bundling could regress an existing feature.

## Caveats / things to verify

- **tsx ignores the `?query` cache-bust (verified — see [Verification](#verification-2026-06-17)).**
  This was the load-bearing assumption of Part 1 and it is **false** on the
  installed tsx **4.21.0** (the issue originally assumed "4.7"; `package.json`
  pins `^4.7.0` but resolves to 4.21.0) / Node 22.22. Any in-process reload must
  use a mechanism that actually re-transpiles (see Part 1 step 3 candidates).
- **Relative-helper edits ARE covered (resolved by the spike) — *if* change
  detection uses the bundle inputs.** The esbuild bundle inlines a tool's relative
  helpers, so editing `./helper.ts` reloads (proven in the spike). The catch: the
  change signature in Part 1 step 1 must hash the bundle's *input set* (esbuild
  `metafile`), not just the entry's mtime — otherwise a helper-only edit leaves
  the entry mtime untouched and the rebundle never fires. Bare-dep edits
  (`ai-ui-automation/tools` itself) are externalized and NOT reloaded — but those
  are the framework's own `dist/`, which has its own "rebuild `dist/` after
  editing `src/`" rule, not user tool code.
- **ESM-registry growth.** A working reload that mints a fresh module per edit
  retains the old one (no GC of the registry) — and, for the namespaced
  approach, a fresh copy of the whole imported subgraph (including
  `ai-ui-automation/tools`). Bounded by edits-per-session — negligible for a dev
  server, but worth a code comment so it isn't mistaken for a leak later.
- **Per-run dir walk cost (Part 2).** Re-indexing every run is an O(files)
  `readdir` tree walk (no imports). Negligible at today's scale, but a project
  with thousands of tool files pays it on every batch — the one cost the lazy
  design set out to avoid at *load*, now reintroduced at *re-scan*. If that
  bites, fall back to the resolve-miss re-scan or `fs.watch`. Worth measuring,
  not pre-optimising.
- **Deletion semantics (Part 2).** Dropping a deleted file from the index turns
  a later reference into "not found" rather than a stale hit — intended. But a
  file that's referenced mid-run, deleted, then referenced again *within the
  same run* won't be re-walked until the next batch; the already-loaded `byFile`
  entry answers. Acceptable (deletes are rare mid-run), but note it.
- **A new file is only seen on the next batch, not instantly.** Part 2 re-walks
  at run start, so a file added *while a run is in flight* is picked up on the
  following run — not the current one. This matches the "no restart needed"
  goal; true live-watch (instant) would need `fs.watch`.
- **Windows mtime resolution.** NTFS mtime is fine-grained (100 ns), so the
  same-tick window is narrow here; the coarse-mtime concern is mainly network
  mounts / containers. Noted for the content-hash alternative.
- **Concurrency.** Steps run sequentially today, so `resolve` needs no locking
  (same assumption the lazy-load design already makes). If tool steps are ever
  parallelised, the re-import path should dedupe in-flight imports per file.

## Tests this would need

- **Core regression (server path):** start a session with `toolsDir`, run a
  `[tool: …]` step and capture its output/log; edit the tool file on disk to
  change behaviour; re-run on the **same session** (no restart) and assert the
  new behaviour. (mtime-bump via `fs.utimes` if needed to simulate a save.)
- **Perf guard (negative):** an unchanged tool file is **not** re-imported on a
  second resolve — assert a single import via a module side-effect counter or a
  spy, so the steady-state cache win is protected.
- **Edit-to-broken:** a healthy tool edited to throw on import → next resolve
  surfaces the new error as a single failed step (isolation preserved, per
  `executeToolStep`), not a stale success.
- **Edit-to-fix:** a tool that failed to import, edited to be valid → next
  resolve succeeds without a restart.
- **New file (server path, symptom B):** start a session with `toolsDir`, run a
  step (so the catalogue exists and is reused); **create** a new tool file on
  disk; reference it on the **same session** → it resolves and runs (no restart,
  no "not found").
- **Deleted file (server path):** resolve a tool, **delete** its file, reference
  it again on a later batch → clean "not found" diagnostic (not a stale hit, not
  a raw import error); then **recreate** it → resolves fresh.
- **Index refresh is import-free:** `refreshIndex()` re-walks and updates
  `fileIndex` without importing any file (assert no module side-effects fire) —
  protects the lazy invariant.
- **Relative-helper edit (new capability from the esbuild mechanism):** a tool
  imports `./helper.ts`; edit **only** the helper; re-run on the same session →
  new helper behaviour is picked up (proves the change signature covers bundle
  inputs, not just the entry mtime).
- **Step-into after reload (the follow-up risk):** F11 into a tool *after* it has
  been edited+reloaded → the debugger pauses in the **original `.ts`** (inline
  sourcemap maps the bundled temp `.mjs` back), and `RegisteredTool.filePath`
  still reports the `.ts`. This is the one test that gates the step-into feature
  against a bundling regression.
- **CLI unchanged:** a one-shot `aiui run` still imports each file once.
- **(If content-hash variant)** edit content **without** advancing mtime
  (`utimes` back to the prior value) → still re-imported (mirrors 026's test
  shape).

## Implemented (2026-06-18)

Shipped both parts. Files:

- **`src/tools/reload.ts` (new)** — `bundleToolModule` / `bundleAndImport`
  (esbuild bundle → unique temp `.mjs` → import → delete), `signatureOf`
  (content hash over bundle inputs), `resolveToolCacheDir`.
- **`src/tools/registry.ts`** — `ToolCatalogue` constructor options
  (`reload` / `scannedDir` / `cacheDir`), a `canReload` gate, signature-checked
  re-load in `resolve`, `loadFile` split (`loadFileDirect` vs
  `loadFileWithReload`), shared `finaliseModule` / `buildToolMap`, and
  `refreshIndex()` (Part 2). `loadToolCatalogue(dir, { reload })`.
- **`src/server/session-manager.ts`** — the reload gate loads with
  `{ reload: true }` and calls `refreshIndex()` on the same-dir/populated branch
  (try/catch backstop).
- **`src/tools/tool-helper.ts`** — comment hardening `IS_DEFERRED_TOOL` as a
  `Symbol.for` (the reload path can inline a second copy of the module).
- **Tests** — `tests/tool-reload.test.ts` (18: edit / unchanged / edit-to-broken
  / edit-to-fix / helper-edit / helper-delete-recreate-recovery / CLI-load-once /
  refreshIndex add-remove-missing-recreate-importfree-noop / step-into sourcemap /
  concurrent-bundle / import.meta / helpers) and two server-path tests in
  `tests/api-server-tools.test.ts` (edit + new-file across batches).

**Two corrections to the spike's recommendation, made during implementation:**

1. **Temp-module location.** The spike said `<projectRoot>/node_modules/.cache/`.
   That **breaks package self-reference**: Node's `LOOKUP_PACKAGE_SCOPE` returns
   null once a `node_modules` segment is in the importer's path, so a temp `.mjs`
   under `node_modules/` can't resolve `ai-ui-automation/tools` via the package's
   own `exports` — it only worked in the spike because the fixtures have a *real*
   symlinked `node_modules/ai-ui-automation`. Fixed by co-locating the cache as a
   dot-dir **inside** `tools.dir` (`.aiui-tool-cache`, skipped by the walk), so a
   temp module resolves bare deps exactly as the tool file does — via self-ref
   (tools inside the framework repo) *or* a real `node_modules` (installed users).
2. **Step-into sourcemap (the flagged follow-up — confirmed broken, then fixed).**
   esbuild emits sourcemap `sources` relative to its working dir (`process.cwd()`
   by default = the server launch dir), but a debugger resolves them against the
   `.mjs`'s own location. Mismatch → breakpoints in the user's `.ts` wouldn't
   bind. Fixed with `absWorkingDir: cacheDir` (metafile keys then resolve against
   `cacheDir` too — `signatureOf` follows). Guarded by a sourcemap-decode test.

**Not a TestBench-extension change (correcting the note below).** The reload code
runs in the **framework API server** (`src/tools/*`, `src/server/*`), which the
extensions reach over HTTP. `runner-core` is a pure client (api-client / SSE /
protocol) and imports none of it; neither `testbench-monaco` nor
`testbench-native` bundles the framework. So **no extension VSIX changed and no
patch-version bump was needed** — the fix ships by restarting the server. The
original implementation note (kept below, struck through) misjudged this.

**User housekeeping.** The `.aiui-tool-cache/` dir is created inside the user's
`tools.dir`. Temp files are deleted right after import, so it's normally empty
(and git ignores empty dirs), but users should add `.aiui-tool-cache/` to their
`.gitignore` so a stray temp `.mjs` (e.g. after a hard kill) never gets staged.
The framework repo's own `.gitignore` already covers it.

## Round-2 review refinements (2026-06-18)

A second independent review confirmed the round-1 fixes correct and surfaced two
reachable (then-dormant) gaps, both fixed + tested:

1. **Concurrent-bundle temp-file race (`reload.ts`).** Two *different* sessions
   sharing one `toolsDir` can bundle the **same** tool content into the **same**
   `.aiui-tool-cache` at once; with a content-hash-only temp filename, the first
   finisher's post-import delete yanked the file out from under the others'
   `import()` (reproduced: 18/20 failed with "cannot find module" — exactly the
   silent failure this issue targets). Fixed: the temp file is named
   `<hash>-<randomUUID>.mjs` — unique per call, so concurrent writes never
   collide (20/20). The content-hash dedup it replaced wasn't actually saving
   anything: under tsx a deleted URL isn't re-served from the registry, and the
   per-file signature check already prevents re-bundling unchanged tools. Cost:
   one ESM-registry entry per *reload* (bounded by edits/session).
2. **`import.meta.url` divergence (`reload.ts`).** A tool resolving a sibling
   resource via `new URL('./x', import.meta.url)` worked on the CLI (direct
   import) but pointed inside `.aiui-tool-cache/` on the server (bundled), giving
   a confusing ENOENT. Fixed by esbuild `define` pinning `import.meta.url` /
   `dirname` / `filename` to the **original** tool file, restoring CLI parity.
   (Safe: the framework's own tool subgraph uses no `import.meta`.)

A wrong code comment (claimed a deleted temp URL is re-served from the ESM
registry — it isn't, under tsx) was corrected. Two cosmetic non-issues were left
as-is: a dir→file swap mid-session renders the "does not exist" hint for a path
that exists-as-a-file (degrade is still correct), and the dot-skip in
`listToolFiles` applies to directories only (pre-existing, unrelated to the cache
dir, which is always a dir).

## Round-3 review refinement (2026-06-18)

A third independent review confirmed the round-2 changes correct and the code
well-factored, and found one more reachable bug, fixed + tested:

**Deleted-then-recreated *helper* left a working tool stuck-broken (`registry.ts`).**
A bundle failure produces no esbuild metafile, so the error-state load couldn't
record the helper set — only the entry. Recreating/fixing the helper (without
touching the entry) didn't change the entry's signature, so `isStale` returned
false and the tool never re-bundled: it stayed broken until the entry was edited
— the exact stale-edit confusion this issue targets, just one level down (a
*helper* rather than the tool file, which `refreshIndex` already handles).
Fixed: `isStale` now **always retries an errored load** (and the error path no
longer records a signature). Recovery is instant for a fix to the entry *or* any
helper; healthy unchanged tools keep the signature short-circuit. Cost: a
persistently-broken tool re-bundles (fast-failing, ~20-40 ms) on each reference —
acceptable. Guarded by a new test (delete helper → recreate, entry untouched →
recovers). Also documented that the `import.meta` `define` pins the *entry*
file's location (a bundled helper in a different dir reading `import.meta.url`
gets the entry's URL — uncommon, noted in code).

## Implementation note (superseded — see correction above)

~~Per CLAUDE.md, the registry is a `file:` dep bundled into each TestBench
extension's `dist/` (via `runner-core`), so the fix must bump the patch version
of any affected variant (`testbench-monaco` / `testbench-native`) and rebuild +
repackage so the installed extension reflects the change.~~ **Incorrect:**
`runner-core` is a client and does not bundle the registry; the registry runs
server-side. No bump was required.

## Discovered while

A user reported that editing a tool and re-running a test step ran the old code
unless the server was restarted. Tracing the lazy-tool-loading path
([registry.ts](../../src/tools/registry.ts) + the server reload gate) surfaced the
two caches behind the stale-edit symptom; the user then asked that newly-added
files be picked up too, surfacing the third vector (the one-shot file index).

## Revisit when

- Tool authoring through TestBench becomes a documented/common workflow (the
  restart-to-verify loop stops being acceptable).
- A user reports "I edited my tool and Continue ran the old version."
- Any move to parallelise tool steps (the no-locking assumption above changes).
