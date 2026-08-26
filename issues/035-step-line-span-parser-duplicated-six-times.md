# 035 — The `## Steps` span parser is duplicated six times (and has already drifted)

**Status:** open / cleanup — deliberately deferred; ideally lands **before**
the inline-sections runtime work (see Sequencing).
**Area (the copies):**
[runner-core/src/step-lines.ts:23-25](../runner-core/src/step-lines.ts#L23-L25) (canonical — strict `STEP_LINE_RE`, no indent);
[testbench-native/src/extension/step-lines.ts:1-13](../testbench-native/src/extension/step-lines.ts#L1-L13) (host copy — mirrors the *webview* copy by its own comment, loose regex);
[testbench-native/src/webview/lib/step-lines-inline.js:1-16](../testbench-native/src/webview/lib/step-lines-inline.js#L1-L16) (webview copy — Vite CJS-interop workaround, loose regex);
[testbench-monaco/src/webview/lib/step-lines-inline.js](../testbench-monaco/src/webview/lib/step-lines-inline.js) (same, second variant);
[testbench-native/src/webview/lib/variables-panel.js](../testbench-native/src/webview/lib/variables-panel.js) (private regexes + own `findStepsSpan` + `parseParametersInline`);
[testbench-monaco/src/webview/lib/variables-panel.js](../testbench-monaco/src/webview/lib/variables-panel.js) (same).
**Deliberate mirror (stays, but untested):**
[src/parser/markdown.ts:462-475](../src/parser/markdown.ts#L462-L475) (`extractStepLinesFromRaw` — server-side; commented "kept here rather than importing runner-core").
**Related:** [013](013-secret-masking-duplicated-and-divergent.md) (same
duplicated-and-divergent theme), the inline-sections specs
([stories/test-script-sections.md](../stories/test-script-sections.md),
[runtime spec §3/§9](../testbench-native/stories/specs/inline-sections-runtime.md))
whose change-impact list touches every copy in lockstep.
**Opened:** 2026-07-22

## Summary

The ~60-line routine that answers "where is the `## Steps` span, and which
lines in it are step lines" exists in **six** client-side implementations
plus one deliberate server-side mirror. Each copy had a locally reasonable
justification, but the copies have **already diverged** — runner-core
rejects indented numbered items (`/^\d+\.\s+\S/`) while all five copies
accept them (`/^\s*\d+\.\s+\S/`) — which is a live CLI-vs-editor
disagreement about what counts as a step. Any feature that changes the line
model (inline sections is the first) must edit all six in lockstep and pin
them with mirrored parity tests. Consolidate to one implementation plus the
commented server mirror.

## Context — why each copy exists

| Copy | Stated reason |
|---|---|
| runner-core `step-lines.ts` | The canonical shared package (bundled into both extensions). |
| webview `step-lines-inline.js` ×2 | Header comment: *"The webview can't import runner-core directly because Vite's CJS interop drops named exports through `__exportStar`."* One per extension variant (the two variants are deliberate side-by-side source trees). |
| native host `step-lines.ts` | Header comment: *"Mirrors the webview's step-lines-inline.js so the extension doesn't depend on webview source."* Also carries genuinely host-specific resume-anchor math (`AnchorChange`, `shiftAnchorForChanges`, …). |
| `variables-panel.js` ×2 | Needed only three regexes + a span finder; inlined a private subset (plus `parseParametersInline`, an inline copy of `parseParameters`). |
| server `extractStepLinesFromRaw` | Explicit comment: the server isn't a runner-core consumer; mirrors the rules so server line numbers agree with editors. **Deliberate — keep.** |

The drift has a traceable lineage: the webview copy was written with the
loose `^\s*\d+\.` rule; the host copy mirrored the *webview* copy and
inherited it; runner-core stayed strict. Nobody chose the divergence — it's
inheritance from mirroring the nearest file instead of the canonical one.

## Decision (for now)

Live with the six copies. The inline-sections specs are written against the
current six-copy world and add mirrored snapshot tests over one shared
fixture table so the copies at least can't drift *further* silently.

## Consolidation plan (when picked up)

1. **Fix the root cause: make runner-core importable from the webviews.**
   Either an ESM-clean build of runner-core (no `__exportStar` in the
   consumed path), explicit named re-exports, or a dedicated browser-safe
   subpath export (e.g. `runner-core/step-lines`) with pure functions only.
   Acceptance test = the original failure mode: both webview bundles build
   under Vite **and** the imported functions are defined at runtime.
   Fallback if Vite resists: generate the inline copy from runner-core
   source at build time instead of hand-mirroring (one source, two
   artifacts).
2. **Delete both `step-lines-inline.js`** and import runner-core from the
   webviews. The native sidebar and monaco decorations keep their current
   behavior via the shared functions.
3. **`variables-panel.js` ×2:** drop the private regexes/`findStepsSpan`/
   `parseParametersInline` and import the same module.
4. **Native host `step-lines.ts`:** shrink to the host-specific anchor math;
   re-export span/step functions from runner-core.
5. **Resolve the strict-vs-loose divergence deliberately: adopt
   runner-core's strict rule** (matches the CLI and the server mirror).
   This is a *visible behavior change* in the extensions: indented numbered
   items stop being treated as step lines (gutter icons, F9, run-line
   resolution). Today the editors accept them but the CLI/server don't — a
   disagreement, not a feature. Release-note it.
6. **Server mirror stays**, but wire it into the shared fixture table
   (parity test in the root `tests/`), so the one remaining intentional
   duplicate is drift-checked instead of comment-checked.
7. Both extensions bundle runner-core and webview code → **patch bump both
   `package.json`s** (CLAUDE.md rule), rebuild, reinstall VSIXes.

## Sequencing

Best ordered **before** the inline-sections runtime PR: that PR must
otherwise apply the new `section-heading` / `section-step` classification
to all six copies (runtime spec §3/§10), and consolidation-first shrinks it
to runner-core + the host anchor file + the server mirror. Not a blocker —
the sections specs are self-consistent against the current world; doing
this later just means the consolidation also merges six section-aware
copies instead of six simple ones.

## Tests this needs

- The shared fixture table (the sections specs place it at
  `fixtures/sections/match-table.json` / classification tables) consumed by
  runner-core, the host file, and the server-mirror parity test — after
  consolidation there should be nothing else left to mirror.
- Webview smoke: both extensions' webviews bundle and execute the imported
  functions (guards the Vite regression that caused the copies).
- A pinned case for the strict-rule adoption: an indented `  1. foo` inside
  `## Steps` is prose everywhere (CLI, server, both editors) — was steps in
  editors before.

## Revisit conditions

Pick up when: (a) the inline-sections feature is scheduled (do this first if
schedule allows), or (b) any other change needs to touch the line model, or
(c) a real bug lands in the strict/loose gap (e.g. a user's indented list
runs in TestBench but not via CLI).

Update 2026-08-26: the family gained its first **mutating** consumer —
`testbench-native/src/extension/renumber-core.ts` (Renumber Steps, PR #92)
re-states the ordinal shape as `/^(\d+)\./` plus a column-0 assumption
carried by its edit shape. A strict/loose drift there rewrites documents,
not just decorations, so when this consolidation lands, export the ordinal
matcher (e.g. `stepOrdinal(rawLine)` → `{start, length, value}`) from
runner-core and adopt it in renumber-core first; `locateMatchText` in
section-index.ts already wants the same shape.

## Why this matters

Six hand-synced implementations of one grammar means every line-model change
is a six-file lockstep edit, and the copies have already proven they drift
(strict vs loose indent rule — a real CLI/editor behavioral disagreement
today). The duplication also quietly shaped feature design: the inline
sections grammar stayed deliberately single-level partly so six flat
scanners wouldn't need hierarchical span logic. One implementation plus one
commented, parity-tested mirror is the right end state.
