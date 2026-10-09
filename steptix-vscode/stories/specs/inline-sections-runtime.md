# Inline sections: Steptix execution, decorations, and debug parity

Companion to the language story
[stories/test-script-sections.md](../../../stories/test-script-sections.md)
(syntax, parser, expander — read it first; this spec assumes its grammar,
including the single match-text derivation) and to
[debugging-ux.md](debugging-ux.md), the step-cache spec (since removed with the
step cache), and [skill-step-rerun-with-variables.md](skill-step-rerun-with-variables.md),
whose machinery sections plug into. The authoring affordances (definition,
completion, diagnostics) are split into
[inline-sections-authoring.md](inline-sections-authoring.md).

## 1. Background — what breaks without this spec

A section body lives *inside* the `## Steps` span, and every client-side
parser defines "step" as "numbered item inside the Steps span". So a
sectioned test opened in today's Steptix doesn't degrade gracefully — it
misbehaves:

1. **Section bodies run as main-flow steps.** `extractSteps`
   ([runner-core/src/step-lines.ts](../../../runner-core/src/step-lines.ts))
   returns *every* numbered item in the span, so `runLines([])` sends the
   body steps as top-level steps *in addition to* the bare-name call — the
   flow runs twice, out of order (once via the AI improvising the bare name,
   once via the literal body lines).
2. The same span rule is duplicated in five more places (the native host
   copy [src/extension/step-lines.ts](../../src/extension/step-lines.ts),
   the two webview inline copies `step-lines-inline.js`, and the two
   `variables-panel.js` copies), so decorations, resume anchors, breakpoint
   trimming, and the Variables panel all miscount.
3. The server never learns section definitions exist: it receives `steps[]`
   already extracted by the client, and it cannot re-read the file because
   the editor buffer may be unsaved.

So Steptix support is not optional polish — **runner-core and both
extensions must at minimum stop treating section bodies as main-flow steps
in the same release that introduces the syntax.** This spec covers that
correctness floor plus full debug parity for steptix-vscode.

## 2. Goals

1. A sectioned test runs correctly from steptix-vscode: bare-name calls
   expand server-side, body steps stream back with per-line status.
2. Section-body lines are first-class in the editor: gutter status icons,
   breakpoints, step-into/over/out, paused-arrow, and re-run-with-variables
   all work inside a section body.
3. Section *invocation* lines inherit the aggregate treatment `[skill:]`
   invocation lines get today (running on `frame:push`, ✓ on a clean
   `frame:pop`, ✗ plus a parked resume point on `step:fail` — all keyed off
   the top-level frame's `testLine`, none of it kind-gated). This falls out
   of the existing `applyToTracker` code with zero changes; the spec's job
   is to *not break it* and to assert it in tests.
4. testbench-monaco (legacy, no skills support) refuses sectioned files
   with a clear error instead of mis-running them.
5. Existing non-sectioned tests behave byte-identically (all six span
   parsers keep their current output when no `###` is present).

### Non-goals (v1)

- "Run selected section steps on a stopped session" (the section analogue of
  [skill-debug-after-stop.md](skill-debug-after-stop.md)). The startAt/endAt
  plumbing supports it, but the command surface is deferred — unlike skills,
  a section body is visible in the test file, so the pain it solves is
  smaller.
- Monaco feature support.

> **Superseded in part.** Two of this spec's consequences turned out to be
> authoring gaps rather than acceptable limits, and are lifted by
> [sections-run-and-resume.md](sections-run-and-resume.md): a selection made
> entirely of body lines now runs those steps (detached, at the root frame),
> and a pause or failure inside a top-level section body now parks its resume
> marker on the **body** line and resumes from there. Where that spec and the
> §3 / §6 text below disagree, that one wins.

## 3. Line model — two new kinds, six call sites, split consumers

`classifyLines` (runner-core) gains two kinds:

- `section-heading` — a depth-3 heading inside the Steps span.
- `section-step` — a numbered item inside a section body.

Rules: within the Steps span, everything up to the first `section-heading`
classifies as today; after it, numbered items are `section-step`, never
`step`. Depth ≥ 4 headings inside the span classify as `heading` (inert),
matching the language story. One deliberate extension beyond
`ANY_HEADING_RE`: an in-span line that is *hashes only* (`/^#{3,}\s*$/` —
invisible to the heading regex, which demands a non-space after the
hashes) classifies as a `section-heading` with an **empty name**. Without
this, a bare `###` line is prose to every client parser: the CLI throws
the empty-name parse error while Steptix happily runs the "body" items
as main-flow steps — the exact CLI/Steptix divergence §4.5 exists to
prevent — and monaco's §8 length check can't see the file's only section.
The empty name then trips the §4.5 pre-flight (and an authoring
diagnostic) exactly like any other refused name.

The step-shaped *functions* split by consumer, and the split must be
explicit because their call sites pull in three directions:

- `extractSteps` / `resolveRunLines` / `classifySelectedSteps` /
  `nearestStepAtOrBelow|Above` operate on `kind === 'step'` only — **main
  flow only**. (`classifySelectedSteps` later grew a trailing `scope`
  argument, defaulting to main-flow; `resolveRunSelection` is the only caller
  that passes anything else. See
  [sections-run-and-resume.md](sections-run-and-resume.md) §4.1.) This
  mechanically fixes §1.1: run-line resolution, the
  native breakpoint trimmer (`trimAtBreakpoint` in
  [src/extension/run-controller.ts](../../src/extension/run-controller.ts),
  which consumes `classifySelectedSteps` output), and resume-anchor math
  never see body lines. (Monaco's webview equivalents are `computeRunnable`
  / `nextBreakpointStop` in its `lib/` — same effect via the shared
  classifier.)
- New `extractSections(text)` returns
  `{ name, headingLine, steps: { line, instruction }[] }[]` for the
  request payload (§4), decorations, and the authoring index.
  `instruction` is the raw line minus the `N. ` prefix, trimmed — exactly
  the treatment `extractSteps` gives main-flow steps today, `[no-hooks]`
  markers preserved. Match text is always *derived* from it (strip
  `[no-hooks]`, trim, casefold — the language story's single derivation);
  no second text form is stored. Implemented once in runner-core beside
  `extractSteps`; the native host copy and the two webview inline copies
  mirror it (same Vite CJS-interop reason the copies exist at all — see
  the header comment in `step-lines-inline.js`).
- **`extractStepLineIds` keeps ONE contract everywhere: main +
  section-step lines.** The native host copy's version
  ([src/extension/step-lines.ts](../../src/extension/step-lines.ts)) feeds
  decoration placeholders, F9 breakpoint validation, and `stepSignature`;
  the **webview copies'** version feeds the native sidebar step list (the
  sidebar reads the webview copy, not the host helper) and monaco's
  editor decorations. Splitting the contract per copy would break §9's
  mirrored parity tables, so both webview copies keep main + body; they
  also mirror `extractSections` purely for §9 copy-parity. (The §4.5
  pre-flight and §8 monaco refusal are *extension-host* code — both
  run-controllers import runner-core directly and consume its
  `extractSections`, not a webview bundle.) The `N/M passed` summary
  switches to a new main-flow-only source (see §5) instead of this
  helper.
- `isTestFile` is unchanged (a sectioned file still has `## Steps`).
- Variables panels (`collectVariables`): these already walk every numbered
  line in the span with their own `STEP_LINE_RE`, so body lines are scanned
  today; the requirement is **don't lose those rows** when the span logic
  becomes section-aware. (The panels scan `[input:]` / `[output:]` /
  `out.*` alias markers only — there is no `[store as:]` row model today,
  and adding one is out of scope here.)

Copy-parity caveat: the six parsers are not rule-identical today —
runner-core's `STEP_LINE_RE` rejects indented numbered items
(`/^\d+\.\s+\S/`) while all **five** copies (native host included) accept
them (`/^\s*\d+\./`). Normalizing that is out of scope; the mirrored parity
fixtures must avoid indented numbered items so the snapshot tests pin the
*new* rules, not the pre-existing divergence. The duplication itself is
tracked as
[#49](https://github.com/steptix/steptix/issues/49)
— if that consolidation lands first, this spec's "all copies in lockstep"
work collapses to runner-core + the host anchor file + the server mirror.

## 4. Request payload, expansion, caching, validation

### 4.1 New request field — and the api-server seam

`StreamStepsRequest`
([runner-core/src/api-client.ts](../../../runner-core/src/api-client.ts))
and the server's `StepRequest`
([src/server/session-manager.ts](../../../src/server/session-manager.ts))
gain:

```ts
/**
 * Inline section definitions from the test file, keyed by lowercased
 * name. Required whenever `steps` (or `fullSteps`) may contain bare-name
 * section calls — the server cannot read the file, the buffer may be
 * unsaved. Line numbers are 1-based in the same document as `sourceLines`.
 * Requires `testFilePath` (section frames and cycle keys derive from it).
 */
sections?: Record<string, {
  name: string;          // as authored (casing preserved for display)
  headingLine: number;
  steps: string[];       // instruction text, same treatment as `steps` above
  stepLines: number[];   // parallel to steps
}>;
```

**The type change alone does nothing.**
[src/server/api-server.ts](../../../src/server/api-server.ts) builds the
`StepRequest` it hands to the session manager from an explicit per-field
allow-list (envName, dataSources, breakpointsByUri, skillsDir, seedScope,
startAt, endAt, … are each individually forwarded); an unlisted field is
silently dropped. `sections` must be added to that forwarding — this is
the same seam that once dropped `envName` — and the
`sections`-without-`testFilePath` rejection (HTTP 400) lives **here**, in
the HTTP layer, not in the session manager. One deliberate departure from
the house pattern: structured fields like `breakpointsByUri` are
shape-checked and silently *dropped* on mismatch — for `sections` a
present-but-malformed value (wrong types, `steps`/`stepLines` arity skew)
is a **400**, not a drop, because dropping degrades to bare-name steps
shipped to the AI: the silent double-execution class this feature exists
to eliminate. §9 requires the server tests to POST through the real
api-server entry for exactly these reasons.

`runStepBlock` (native `run-controller.ts`) builds the field from
`extractSections(text)` on **every** request that carries steps from the
document: initial runs, breakpoint-continuation batches, and partial
re-runs. Continuations must resend it for the same reason they resend
`fullSteps` — the server holds no cross-batch document state, and both
expansion and cache hashing must see identical definitions in every batch.
**Empty means absent**: the client omits the field entirely when the file
defines no sections (the house conditional-spread pattern), and the server
treats an empty map as an absent one — the widened expansion gate (§4.2)
and the 400 validations apply to *non-empty* maps only, so sectionless
native runs keep byte-identical legacy behaviour (including Migration
edge 3's raw pass-through promise).

The server **trusts** the map (a `Record` cannot even represent a
duplicate name — JSON parsing collapses it, last key wins), so validation
is client-side (§4.5) and CLI-side (parse errors). Empty invoked bodies
and cycles remain expander errors server-side regardless.

### 4.2 Server-side expansion gating and the expander signature

Today the server expands only when `skillsDir` is present
(`if (request.skillsDir)`). Sections must expand even in a project with no
skills directory, so the gate widens to `skillsDir || request.sections`.

`expandSkills`' positional signature grows an options argument
(`{ sections?, rawSteps? }`, per the language story — the server passes
`sections` only; its incoming steps are already the raw/instruction form,
so no `rawSteps` parallel is needed) and `skillsDir` becomes optional. The
server threads `request.sections` into **both** of its call sites: the
execution expansion *and* the cache-hash expansion (§4.3). Behaviour
change worth stating: for a request that carries `sections`, a `[skill:]`
step with no `skillsDir` previously shipped as raw text to the AI (the
legacy no-expansion path); under the widened gate it becomes a clean
expansion error naming the missing `skillsDir`. Requests with neither
`sections` nor `skillsDir` keep the legacy pass-through.

The expansion emits `frame:push` / `frame:pop` around section bodies with
`FrameInfo.kind: 'section'` (§4.4). Per-step `line` values for body steps
come from the section's `stepLines` via expansion origins — the same path
skill-body lines take. When inlining a body, the expander strips a leading
`[no-hooks]` marker from each body step (the payload carries markers
verbatim; the CLI parser strips them at parse time, and without the
expander-side strip the literal marker text would reach the AI on the
server path only — an execution-text divergence the language story's
Semantics section calls out).

### 4.3 Caching: bundle hash, per-step keys, and warning dedup

> The step cache this section was written for has since been removed; only
> code-behind replays now. The bundle-hash and per-step-key rules below, and
> every "per-step cache" mention elsewhere in this spec, are kept as history.

Two cache paths must become sections-aware or multi-batch runs misbehave:

- **Bundle hash source.** `chooseCacheHashSource(steps, fullSteps,
  !!request.skillsDir)`
  ([src/server/cache-hash-source.ts](../../../src/server/cache-hash-source.ts))
  decides between hashing raw text and hashing the expanded full document.
  The third argument widens to `!!request.skillsDir ||
  !!request.sections`, and the full-document expansion call
  (`expandSkills(request.fullSteps, …)`) receives the same `sections` map.
  Without both, a sections-only project takes the `'raw-full'` branch
  (hash over unexpanded bare names — stable, but blind to body edits) on
  subset batches while full runs hash the expansion — the hash flips
  between batches of one run, wiping the cache at every breakpoint
  Continue; and in skills-enabled projects the hash expansion would
  silently drop section bodies.
- **Per-step keys on subset batches.** `frameScopedStepKey(frameId, line)`
  uses frame ids minted per `expandSkills` call (`f1, f2, …`); a subset
  batch expands only its slice, so its ids restart and can collide with a
  *different* invocation's ids from an earlier batch — replaying a frozen
  plan against the wrong page state. This is latent for skills today;
  sections make repeated invocation of identical body lines the norm.
  **v1 rule:** on a subset batch (`fullSteps` present and `steps` ≠
  `fullSteps`), per-step cache **reads and writes are skipped for steps in
  non-root frames** (root-frame steps keep their stable `frameId === ''`
  keys; `cacheEnabled` already gates read and write at the same
  `executeStep` seam, so the rule is implementable where the cache is
  consulted). Be explicit about the trigger surface: subset batches are
  not just breakpoint continuations — **`[input:]` / `[interactive:]`
  block-splits and selection / run-step-here runs also send `steps` ≠
  `fullSteps`**, so skill-body steps lose per-step caching there too. For
  existing skill projects that trades occasional (and occasionally
  frame-id-collision-wrong) hits for guaranteed-correct misses; recorded
  as Migration edge 4 in the language story. Full-document runs keep
  today's behaviour. Aligning batch frame ids to the full-document
  expansion (which would restore hits) is future work.
- **Dead-section warning dedup.** The server may expand up to twice per
  batch (execution + cache hash) across N batches per run, and the log
  bridge forwards `logger.warn` to the client. The cache-hash expansion
  passes `warnDeadSections: false` (the expander option from the language
  story), and the execution site derives the flag from batch shape —
  warn only when `fullSteps` is absent or `steps === fullSteps`. Accepted
  consequence: a run that is subset-batched *from its first request*
  (breakpoint-trimmed, `[input:]`-split) emits **no** run-log warning at
  all — dead sections there surface via the editor diagnostic and the
  next full run. CLI behaviour (warn once at parse) is unaffected; a dead
  section *inside a skill file* is scanned by the **expander** on first
  entry into that skill file within one `expandSkills` call (gated by the
  same `warnDeadSections` flag, deduped within the call) — it cannot live
  in skill *parsing* because `clearSkillCache()` runs at the top of every
  batch, which would re-fire a parse-time warning per batch.

Also for §7's benefit: it is `startAt` that forces the per-step cache off
on partial re-runs (`isPartialRerun`), not `seedScope` — the `seedScope`
docstring in `session-manager.ts` overstates; don't propagate that
wording.

### 4.4 Protocol widening

`FrameInfo.kind` ([runner-core/src/protocol.ts](../../../runner-core/src/protocol.ts))
widens to `'test' | 'skill' | 'section'`; `skillName` carries the section
name when `kind === 'section'`. Client audit of `frame.kind` uses: the
**only** kind-gated code in the extension today is `maybeRevealFrame`
(§5) — everything else keys off `parentId`/lines and needs no change. The
Stop-time `SkillDebugContext` capture is *not* kind-gated today and must
become so via new plumbing (§7). Legacy-server tolerance is unchanged
(frames stay optional on step events).

### 4.5 Native pre-flight validation

The CLI refuses duplicate/reserved section names at parse time; the wire
format can't represent duplicates at all (§4.1). So `runStepBlock` gains a
pre-flight: if `extractSections(text)` yields a duplicate
(case-insensitive) or reserved / `[`-prefixed / `{{`-containing / empty
name, refuse the run with a TB-coded error before any request is built —
same pattern as monaco's §8 refusal. (Empty names are visible to
`extractSections` only because of §3's hashes-only classification rule —
that rule is what makes this bullet implementable.) This keeps "the CLI errors, Steptix
runs anyway with last-definition-wins" from ever happening.

## 5. Editor surfaces (native)

- **Decorations** ([src/extension/decorations.ts](../../src/extension/decorations.ts)):
  placeholder cells and status icons extend to `section-step` lines (via
  the §3 `extractStepLineIds` contract). Body steps get the same
  ✓ / ✗ / ▶ treatment as main steps — this is where sections beat
  skills ergonomically: the whole run paints in one editor.
- **Invocation-line aggregates** come free (Goal 3): `applyToTracker`
  paints `running` on the top-level frame's invocation line at
  `frame:push`, ✓ at clean `frame:pop`, and ✗ + parked resume point at
  `step:fail` — none of it checks `frame.kind`. With that, the summary
  stays coherent: **the `N/M passed` summary counts main-flow lines only**
  (a new main-flow-only line source replaces `extractStepLineIds` here; M
  is the author's step count, and body lines can be visited 0 or 2+ times
  per run). An all-green sectioned run reads M/M because the invocation
  line itself carries a ✓.
- **Sidebar step list** (`steptix-runner.jsx`, built from the *webview
  copy's* `extractStepLineIds`): shows main *and* body rows in document
  order — matching where statuses actually land. No grouping/indentation
  work in v1.
- **Run-state persistence** ([src/extension/active-file-tracker.ts](../../src/extension/active-file-tracker.ts)):
  `stepSignature` hashes `extractStepLineIds` lines today, which under the
  new grammar already includes body lines — the §3 split must not remove
  them, and `section-heading` lines are added so renaming a section (or
  moving a boundary) invalidates persisted statuses. Resume-anchor shift
  math (`shiftAnchorForChanges`) operates on main-flow lines and is
  unaffected.
- **Paused arrow / step-into**: `step:awaiting` events carry body lines +
  section frames; the yellow ▶ paints on the body line.
- **Frame reveal**: `maybeRevealFrame` currently early-returns unless
  `frame.kind === 'skill'`, so section frames get no reveal at all. Edit:
  admit `kind === 'section'` past the gate, then branch — if `frame.uri`
  equals the *controller's* document path (not "the active editor", which
  may be elsewhere), reveal the line in place in the existing editor;
  otherwise keep the open-beside behaviour (skill files).
- **Run-from-cursor on a body line**: `resolveRunLines` finds no main-flow
  step at/below a body line (sections trail the main flow) and returns
  `[]` — which `classifySelectedSteps` then treats as "every step",
  silently running the whole test against the live session. The guard
  belongs at the **single choke point in `RunController.runLines`**
  (requested lines non-empty ∧ resolved lines empty → refuse with a
  status-bar hint: "place the cursor on a main-flow step, or use Run
  All"), because the user-gesture entry paths include the webview `run`
  message, `runSelected`, and `runStepHere` — and only the latter two go
  through `commands/index.ts` (Continue/Step and the re-run flows call
  `runLines` too; the guard covers them all). Legitimate flows can't trip
  it: batch mode passes `[]` (run everything), continuations and both
  re-run paths pass explicit main-flow lines. Note this also fixes a
  pre-existing footgun in *non-sectioned* files — a selection entirely
  past the last step currently resolves to "run everything" — recorded as
  Migration edge 5 in the language story.
- **Stale pause marker on a body line — the guard's blind spot, closed at
  the resume commands.** §6 parks breakpoint pauses on *test-file body
  lines* for the first time. If a run dies without clearing the marker
  (stream drop, server restart, error path — nothing clears it except
  Stop, a new run, or the next `step:start`), Continue and
  Step-from-breakpoint compute `resumeLines = extractSteps(text).filter(l
  >= parkedLine)` — **empty** for a body line, and they'd call
  `runLines([], …)`, the literal "run everything" convention the §5 guard
  cannot distinguish from batch mode. So `continueRun` and `dispatchStep`'s
  breakpoint-paused branches gain their own check: if the parked line is
  not a main-flow step line (equivalently, the filtered resume list is
  empty), refuse with the same status-bar hint instead of resuming.
  (Unreachable today — skill pauses park on the skill URI — reachable the
  day sections ship.)

## 6. Breakpoints inside section bodies

Current contract (documented on `breakpointsByUri` in both
[api-client.ts](../../../runner-core/src/api-client.ts) and
[session-manager.ts](../../../src/server/session-manager.ts)): test-file
breakpoints are handled **client-side** — `trimAtBreakpoint` splits the
run into batches at main-flow breakpoint lines — and the server drops
test-file entries at map-build time (`if (uri === request.testFilePath)
continue`), checking only skill-file entries and pausing via
`step:awaiting`.

Section-body breakpoints break that dichotomy: they are test-file lines the
client *cannot* trim (body lines are never in the runnable main-flow list —
§3 guarantees that). Rule change, one on each side:

> **Amended.** "Never in the runnable list" now holds for every run *except*
> a detached body run — one whose whole selection is body lines
> ([sections-run-and-resume.md](sections-run-and-resume.md) §4.2). There the
> body steps ARE the runnable list, so `trimAtBreakpoint` does see them and
> pauses client-side. No double trigger results: those steps execute at the
> root frame, and the server's per-step check below skips a test-file
> breakpoint exactly when the step's frame is the root.

- **Client** (native): F9 validation in `commands/index.ts` accepts
  `section-step` lines (it validates against `extractStepLineIds`, which
  §3 already extends); heading, prose, and blank lines stay refused with
  the existing message. `trimAtBreakpoint` continues to see main-flow
  steps only, so a breakpoint on an *invocation* line pauses before the
  invocation (batch split — today's behaviour for any main-flow line), and
  body-line breakpoints ride the per-URI map to the server as they already
  do via `allMarkdownBreakpoints`.
- **Server** (`session-manager.ts` map-build + check): stop dropping
  test-file entries wholesale. Instead, at the per-step check, skip the
  breakpoint **only when the step's frame is the root frame** (`frameId ===
  ''`). Root steps remain client-trimmed (no double trigger); section-body
  steps (non-root frame, same URI) now pause server-side with the same
  `step:awaiting` flow skill-file breakpoints use. Skill-file behaviour is
  untouched (their URIs never equal `testFilePath`).

The existing `consumedBreakpoints` set already prevents re-triggering on
resume; nothing else changes. F5/F10/F11/Shift+F11 semantics inside a
section come free from the frame-depth logic (`over` skips a section body
as one step; `out` runs to the end of the current section body).

## 7. Re-run a section step with variables

The [skill-step-rerun-with-variables.md](skill-step-rerun-with-variables.md)
machinery extends to top-level section frames. The pieces:

- **Failure capture** ([src/extension/run-controller.ts](../../src/extension/run-controller.ts)):
  `recordSkillFailure`'s only gate is `parentId === null` and the event
  router passes every frame, so top-level section frames already flow
  through. `SkillFailure` gains a **`kind: 'skill' | 'section'`** field
  (recorded from `frame.kind`); for sections, `skillUri` is the test file
  (`frame.uri`) and `skillLine` the failed body line.
- **Stop-time gating** (`commands/index.ts`): `performStop({ setSkillDebug:
  true })` derives the [skill-debug-after-stop.md](skill-debug-after-stop.md)
  context from `lastSkillFailure`. That flow is skill-file-oriented; it
  must consume the failure **only when `failure.kind === 'skill'`** so a
  section failure doesn't half-activate it with `skillUri` = the test
  file. (Nothing to gate on existed before the new `kind` field — this is
  new plumbing, not a relaxation.)
- **Variables panel rows**: for section frames, captured/runtime rows are
  editable as for skills — and **test-parameter rows are editable too**.
  The skill-side read-only rationale ("baked into the step text at
  expansion") does not apply: section bodies are never pre-interpolated,
  `{{param}}` resolves at runtime against `resolvedParameters`, and
  `seedScope` merges over `parameters` (seed wins) — an edited param
  genuinely takes effect on the re-run tail. This needs real
  protocol/webview plumbing, not just words: `HostSkillRerunAvailableMsg`
  gains the failure `kind`; the webview's row-editability rule (`readOnly
  = isParam || masked` today) becomes `readOnly = (kind === 'skill' &&
  isParam) || masked`; `WebviewRerunSkillStepMsg.edits` may then carry
  param names for section re-runs, and both message docstrings in
  [runner-core/src/protocol.ts](../../../runner-core/src/protocol.ts)
  (which currently promise params are never editable) are updated. Masked
  (secret-shaped) rows stay non-editable, as for skills. The panel heading
  shows the section name; `paramNames` still comes from
  `parseParameters(readFileSync(failure.skillUri))`, which for a section
  frame reads the test file — i.e. exactly the test's own `## Parameters`,
  now serving as the *labelling* for editable-param rows rather than a
  read-only marker.
- **The re-run request**: `rerunSkillStepFromFailure` sends
  `startAt: { uri: <test file>, line: <failed body line> }` with the
  seeded scope via `runLines([failure.testLine], …)` (re-sending the
  single invocation step **plus the `sections` map**, per §4.1). `startAt`
  forces the per-step cache off (§4.3).
- **Anchor guard (server)**: `uriOfStep` returns the test file for *every*
  section frame, nested ones included — so if the failed section's body
  invoked a sibling section (defined lower in the file) *before* the
  failed step, that nested body step precedes the failed step in expansion
  order with a source line ≥ `startAt.line`, and the plain
  first-match-wins scan would anchor inside the *nested* body, silently
  re-running already-passed steps. Guard: when `startAt.uri ===
  testFilePath`, restrict anchor candidates (and `endAt` matching) to
  steps whose origin frame is **top-level** (`frame.parentId === null`) —
  root-frame steps (`frameId === ''`, which have no frame record) also
  qualify, so a hypothetical full-document request with a test-file
  anchor keeps today's semantics. The failed step always qualifies (its
  frame is the top-level invocation in the re-run request's own
  expansion); nested section bodies never do.
- **Skills that define internal sections — refuse both flows in v1.** The
  guard above cannot help when the anchor URI is a *skill* file: a
  skill's internal-section frames carry the skill file's URI, their body
  lines are numerically above the skill's main flow, and a naive
  top-level-only restriction would break debug-after-stop's whole-body
  runs when the body *starts* with a section call. Safe line-anchor
  semantics there need "compare against the step's top-level-ancestor
  source line", which is an anchoring redesign, not a patch. So v1:
  `rerunSkillStepFromFailure` and `runSkillStepsOnStoppedSession` refuse
  (TB-coded message) when the target skill file defines sections — both
  flows already read the skill file, so the check is one
  `extractSections(text)` call. **The check runs only when
  `failure.kind === 'skill'`** — for a section failure, `skillUri` *is*
  the test file, which by definition defines sections, and a kind-blind
  check would refuse every section re-run; `runSkillStepsOnStoppedSession`
  is skill-kind by construction (its context comes from the §7 Stop gate).
  Deferred with the redesign (language story, Open questions). Section
  re-runs in the *test* file are unaffected.
- **Scope capture**: `frame:scope` snapshots for section frames carry
  test-scope names (shared scope — section bodies mint no `__skill*`
  internals of their own). The editable view works as specced for skills.
- **Call stack view**: renders section frames correctly by accident today
  (label from `skillName`, description `file:line`); v1 keeps that,
  optionally adding a "(section)" description suffix. Asserted in §9, no
  structural change. The Variables view, however, would mislabel: its
  *description* (the title itself is the constant "Variables") is set by
  `updateTitle()` in
  [src/extension/variables-view.ts](../../src/extension/variables-view.ts),
  keyed today on `skillName` *presence* — and section frames carry
  `skillName`, so the panel would read "skill: <section name>". New rule:
  the prefix derives from `frame.kind` (`skill:` / `section:`).

Nested sections (a section invoked from inside a skill or another section)
stay out of re-run scope, same as nested skills: `parentId === null` gates
capture.

## 8. testbench-monaco: refuse, don't mis-run

Monaco doesn't send `skillsDir` or frames and gets none of the above
feature work. It does share `step-lines-inline.js` / `variables-panel.js`
copies, which keep the shared `extractStepLineIds` main+body contract
(§3) and gain `extractSections`. Monaco's protection against mis-running
comes **from the run refusal itself**, not from line reclassification —
body lines remain step-like in its editor decorations, which is harmless
cosmetics once sectioned runs are refused. On Run, its run-controller
checks `extractSections(text).length > 0` and refuses with a new TB-coded
error
("this file uses inline sections — run it with steptix-vscode or the
CLI") rather than sending a bare-name step to the AI. (This blanket
refusal also covers the duplicate-name case §4.5 handles for native.)
Both extensions get a patch-version bump (runner-core is bundled into
each).

## 9. Testing

The shared match-table fixture referenced by every suite lives at
**`fixtures/sections/match-table.json`** in the repo root — one canonical
file consumed by the src parser/expander tests, the runner-core tests, and
the extension host/webview copy tests (three packages, one table, no
drift). Rows include: exact match, case-insensitive, trimmed,
`[no-hooks]`-prefixed **and `[NO-HOOKS]`-cased** (the CLI marker regex is
case-insensitive; every reimplementation of the strip must match), bold/
backtick formatting (no match), byte-equal formatted pair (match),
trailing punctuation (no match), a formatted call site inside a skill
body (no match), and a locale-sensitive-casing name (e.g. `İşlem`) that
pins `toLowerCase()` — not `toLocaleLowerCase()` — semantics across
implementations.

- **runner-core unit:** classification table for a sectioned fixture
  (step / section-heading / section-step / heading-inert `####` / bare
  `###` → empty-name section-heading per §3); `extractSteps` excludes
  bodies; `extractSections` shape incl. the empty-name entry; no-`###`
  files produce today's output byte-for-byte (regression corpus =
  existing fixtures; fixtures avoid indented numbered items per §3's
  parity caveat).
- **Copy-parity:** the native host copy and both webview inline copies run
  the same fixture tables (mirrored snapshot tests), including the
  match-table rows.
- **Server (through the real api-server HTTP entry, not `SessionManager`
  directly — the allow-list seam is the thing under test):** request with
  `sections` + no `skillsDir` expands bare-name calls; `sections` without
  `testFilePath` → 400; malformed `sections` (wrong shape / arity skew) →
  400, not a silent drop; body-line breakpoint under
  `breakpointsByUri[testFile]` pauses on the body step (root steps still
  don't double-pause); `startAt` at a body line runs the tail of the
  section only; **anchor guard**: section→section chain where the nested
  call precedes the failed step — re-run starts at the failed step, not
  inside the nested body; a body-line `[input:]` is auto-skipped
  server-side exactly like a skill-body `[input:]` (the language story's
  carve-out); bundle hash stable across a breakpoint continuation in a
  no-`skillsDir` project, and a body edit between batches changes it; on
  a subset batch, non-root steps neither read nor write per-step cache
  entries (root steps still do) — pinned for both a breakpoint
  continuation *and* an `[input:]`-split run; dead-section warning
  emitted exactly once for a **full-batch** run and not repeated per
  batch/expansion site — including a *skill-internal* dead section across
  a breakpoint continuation; a body step sent with a leading `[no-hooks]`
  reaches the AI with the marker stripped; an **empty** `sections` map is
  treated as absent (legacy gate, no 400 path); `[skill:]` with no
  `skillsDir` in a sectioned request → clean error.
- **Native integration** (electron harness — FakeApiClient + fixture env
  files, per the existing harness pattern): sectioned test run end-to-end:
  gutter statuses on body lines; invocation line shows running → ✓ (and ✗
  + parked resume on a failing body step); summary reads M/M all-green
  counting main flow only; F9 toggles on a body line and refuses a heading
  line; sidebar lists main + body rows; breakpoint in body pauses with
  yellow ▶ on the body line; F11 steps into a section and the call stack
  shows the section name; re-run-with-vars from a failed body step sends
  `startAt{testUri, bodyLine}` + `seedScope` + `sections`, and an edited
  *test param* takes effect on the tail (webview marks param rows editable
  only for `kind === 'section'`); Stop after a section failure does *not*
  activate skill-debug context; re-run-with-vars and debug-after-stop are
  refused when the failed *skill* defines internal sections; editing a
  section heading between runs invalidates persisted statuses
  (`stepSignature`); run-from-cursor on a body line is refused with the
  hint (via the `runLines` choke point, so the webview path is covered
  too) — and the same refusal fires for a past-the-end selection in a
  non-sectioned file; Continue/Step against a stale body-line pause
  marker refuse instead of re-running the whole test (§5's resume-command
  check); duplicate-name pre-flight refusal (§4.5); monaco refusal path
  (via runner-core's `extractSections`) unit-tested.
- **Live suite:** one `STEPTIX_LIVE_GREP`-able scenario against the real
  server exercising run + body breakpoint + continue (cache off, per the
  §4.3 subset-batch rule this also pins).

## 10. Change-impact checklist

| Area | Change |
|---|---|
| runner-core `step-lines.ts` | new kinds, `extractSections`, main-flow-only `extractSteps` |
| runner-core `api-client.ts` | `sections` request field; update `breakpointsByUri` docstring (§11) |
| runner-core `protocol.ts` | `FrameInfo.kind` widens; rerun message docstrings + failure `kind` (§7) |
| native `step-lines.ts` (host copy) | mirror §3; `extractStepLineIds` = main + section-step |
| native+monaco `step-lines-inline.js` ×2 | mirror §3 |
| native+monaco `variables-panel.js` ×2 | keep body-line rows under section-aware spans |
| native `run-controller.ts` | send `sections` on every request; §4.5 pre-flight; §5 `runLines` empty-resolution guard; `SkillFailure.kind`; §7 re-run semantics + sectioned-skill refusal |
| native `commands/index.ts` | F9 accepts section-step lines; `performStop` skill-debug capture gates on `kind === 'skill'`; `runSkillStepsOnStoppedSession` sectioned-skill refusal; Continue/Step refuse a stale body-line pause marker (§5) |
| native `steptix-runner.jsx` (webview) | param-row editability by failure `kind`; sidebar rows incl. body lines |
| native `decorations.ts` | paint section-step lines; summary switches to main-flow-only source |
| native `active-file-tracker.ts` | `stepSignature` keeps body lines + adds `section-heading` lines |
| native `extension.ts` | `maybeRevealFrame` admits sections + same-file in-place reveal |
| native `variables-view.ts` | `updateTitle()` description prefix derives from `frame.kind` (`skill:` / `section:`) |
| native `call-stack-view.ts` | no structural change; §9 asserts section frames render |
| monaco `run-controller.ts` | refuse sectioned files (new TB error) |
| server `api-server.ts` | **forward `sections`** (per-field allow-list!); 400 for `sections` without `testFilePath` |
| server `session-manager.ts` | widen expansion gate; thread sections into **both** `expandSkills` sites; root-frame-only breakpoint skip; §7 anchor guard; subset-batch per-step cache rule; warning dedup; `outermostSectionName` for `StepResult.sourceSection`; widen the hand-mirrored `FrameInfo.kind` union; update `breakpointsByUri` docstring |
| server `cache-hash-source.ts` | `chooseCacheHashSource` third arg: skills **or** sections |
| both `package.json` | patch bump |

## 11. Companion-doc updates (contracts this spec changes)

- step-cache-server.md (since removed with the step cache) — request-field
  table (`sections`), the expansion gate, and the §4.3 subset-batch per-step
  cache rule.
- [skill-step-rerun-with-variables.md](skill-step-rerun-with-variables.md)
  — §2's "params are read-only" table and the edge-case row "User edits a
  param — not possible in v1" become skill-frame-specific; link here for
  the section-frame behaviour; add the sectioned-skill refusal (§7).
- [skill-debug-after-stop.md](skill-debug-after-stop.md) — the Stop
  capture additionally gates on `SkillFailure.kind === 'skill'`
  (skill-vs-section; top-level-ness is still enforced by the existing
  `parentId === null` gate — the kind check supplements it, never
  replaces it); add the sectioned-skill refusal (§7).
- [run-state-persistence.md](run-state-persistence.md) — `stepSignature`
  input gains section-heading lines.
- `breakpointsByUri` docstrings in `runner-core/src/api-client.ts` and
  `src/server/session-manager.ts` — "test-file entries are skipped
  server-side" becomes "root-frame steps are skipped; non-root same-file
  steps (inline sections) pause server-side".
