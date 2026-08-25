# Test-script sections: inline reusable step blocks

## Context

Skills are the framework's only reuse mechanism today, and they carry real
ceremony: a separate `.md` file in `skillsDir`, `type: skill` frontmatter,
declared `## Parameters` / `## Outputs`, and a `[skill: name args]` call line.
That ceremony is right for flows shared *across* tests, but authors keep
hitting a smaller need: group a handful of steps *within one test*, give the
group a name, and call it (possibly more than once) from the main flow —
without leaving the file or inventing parameters for something that already
shares the test's scope.

Today there is nowhere to put such a block. The parser
([src/parser/markdown.ts](../src/parser/markdown.ts), `parseSections`)
recognises the H1 title and five reserved H2 sections (`Config`,
`Parameters`, `Outputs`, `Steps`, `Hooks`). A `###` heading *inside*
`## Steps` is not a boundary of any kind: the token walk leaves
`currentSection === 'steps'`, so numbered items after it are silently
appended to the main flow, and the raw line scanner
(`extractStepLinesFromRaw`) likewise only breaks on headings of depth ≤ 2.
The client-side step classifier
([runner-core/src/step-lines.ts](../runner-core/src/step-lines.ts)) has the
same rule. In other words, the `###` namespace inside `## Steps` is
unclaimed — and unused: no markdown test or skill file in `fixtures/` or
`templates/` contains a `###` heading (verified; vendored `node_modules`
and the HTML report templates don't count).

This story claims it: **a `### Name` heading inside `## Steps` defines a
named section — an inline skill, minus the file and the parameter ceremony.**
A step invokes it by writing the section's name as the entire step text.

Two companion specs cover the editor side:
[testbench-native/stories/specs/inline-sections-runtime.md](../testbench-native/stories/specs/inline-sections-runtime.md)
(TestBench execution, decorations, breakpoints, step-into, re-run) and
[inline-sections-authoring.md](../testbench-native/stories/specs/inline-sections-authoring.md)
(go-to-definition, completion, diagnostics).

## Goals

1. Let a test define named step blocks inline and invoke them by name, with
   no new file and no parameter declarations.
2. Reuse the existing skill-expansion machinery — flat step list, per-step
   origins, frames — so the runner, server, report, and step-into protocol
   see sections through the same lens as skills.
3. Scope transparency: a section's steps behave exactly as if they were
   authored at the call site, in whatever frame that call site lives in.
4. Keep every existing file parsing exactly as before, except the (unused,
   verified-absent) case of a `###` heading inside `## Steps`.
5. Sections work in skill files too — a skill body may define and invoke
   its own sections, which then live inside that skill instance's scope.

### Non-goals (v1)

- **Per-section parameters / outputs.** Sections are macros, not functions.
  A section that needs isolation or arguments should be promoted to a skill
  file. (A future `#### Parameters` nested under a section heading is the
  natural extension point; nothing in this design blocks it.)
- **Cross-file section reuse.** Sections are file-local by definition —
  that's the difference between a section and a skill.
- **A call token.** There is no `[section: name]` syntax; the bare name *is*
  the call. `[skill:]` keeps meaning "file in skillsDir" and never resolves
  to a section.
- **Section calls in `## Hooks` / `defaultHooks`.** Hook entries are
  expanded without a sections map: a hook entry equal to a section name
  stays an ordinary AI step. (Project-level `defaultHooks` are file-agnostic
  strings, so resolving them per-file would be surprising; per-test hooks
  follow the same rule for consistency.) Revisit if a real need appears.

## Syntax

```markdown
# Checkout smoke test

## Parameters
- username: $LOGIN_USERNAME
- password: $LOGIN_PASSWORD

## Steps
1. Login
2. Add the first product to the cart
3. Checkout
4. Verify the order confirmation page shows "Thank you"

### Login
1. Navigate to {{baseUrl}}/login
2. Type "{{username}}" into the username field
3. Type "{{password}}" into the password field
4. Click Sign in and verify the dashboard loads

### Checkout
1. Open the cart
2. Click the checkout button
3. [skill: fill_payment_form]
4. Click Place order
```

### Grammar

- **Definition.** Inside the `## Steps` section, each `### Name` heading
  starts a section. Its body is every numbered list item until the next
  heading of depth ≤ 3 (the next `###` section or the next `##` H2) or EOF.
  A heading of depth ≥ 4 *with heading text* inside the span does not close
  the body it sits in — but it opens an **ignored region**, and every
  numbered item from there to the next `###` (or the end of the span) is
  inert: not a main-flow step, not a body step, and nothing runs it. The
  first cut called such a heading "inert prose" and then absorbed the items
  beneath it — into the main flow when no section was open, into whichever
  body was when one was — and ran them, silently. See the contract §5 rule
  4a for the classification and `inert-step`. A raw line that is **hashes only** (`/^#{3,}\s*$/`,
  any depth ≥ 3) inside `## Steps` is an empty-name section heading — a
  parse error — not prose: the client-side classifiers cannot tell a bare
  `###` from a bare `####` apart from raw text, so the CLI must refuse
  every in-span hashes-only line to stay in lockstep with the editors
  (which refuse such files pre-run).
- **Main flow.** The numbered items under `## Steps` *before the first
  `###`*. The main flow cannot resume after a section block — once the first
  `###` appears, every later numbered item inside `## Steps` belongs to a
  section.
- **Name.** The heading's raw text after `### `, trimmed. Spaces are allowed
  (`### Login as admin`) — names are matched as whole step text, not
  tokenized. Matching and duplicate detection are **case-insensitive**.
  Refused at parse time (error): names equal to a reserved H2 keyword
  (`steps`, `config`, `parameters`, `outputs`, `hooks`, any casing — cheap
  insurance against a file that reads like it has two `Steps` sections),
  names beginning with `[` (bracket-token steps are claimed by the
  invocation parsers first, so such a section could never be invoked),
  names containing `{{` (inside a skill, `applySkillScope` rewrites
  `{{…}}` in call-site lines but heading keys are data — the call would
  silently stop matching after interpolation; ban it everywhere rather
  than have it work in tests and break in skills), and empty names.
- **Invocation.** A step is a section call iff its *match text* (below)
  equals the match text of a section name defined in the same file.
  Anything else — including near misses — is an ordinary AI step. Steps
  that parse as `[skill:]`, `[tool:]`, `[input:]`, or `[interactive]` are
  checked for those tokens *first* and are never section calls; the
  bare-name test applies only to plain-text steps.
- **Placement of definitions vs. calls** is unordered: a call may precede or
  follow its section's definition (definitions necessarily follow the main
  flow, so the common case is call-above/definition-below).
- Sections may invoke other sections (same file) and skills. Skill files'
  `## Steps` follow the same grammar, so a skill body may define and invoke
  its own sections.
- **Definitions do not nest.** There is no `#### SubSection` — a `####`
  heading never defines anything (with text it opens an ignored region, so
  nothing under it runs; hashes-only is the empty-name error above). A section gets sub-flows by *calling*
  sibling `###` sections by name; call nesting is arbitrary-depth (shared
  `MAX_DEPTH`/cycle guards with skills), definition structure is flat.
  This keeps every span parser single-level and reserves the `####`
  namespace inside a body for the future per-section
  `#### Parameters` / `#### Outputs` blocks (see Non-goals).

### The match rule (one derivation, every parser)

Whether a step is a call must be decided identically by the CLI parser, the
server, and the TestBench editors — otherwise the same file executes
differently depending on how it was launched. One derivation, applied to
both sides of the comparison:

```
matchText(s) = casefold(trim(stripLeadingNoHooksMarker(s)))
```

`casefold` is **`String.prototype.toLowerCase()`** — the
locale-independent one, never `toLocaleLowerCase()` (which follows the
host locale: a Turkish-locale client and a C-locale server would disagree
on dotted/dotless I). The same function produces the section-map keys and
the match text on every implementation, client and server. The marker
strip is case-insensitive (`[no-hooks]` / `[NO-HOOKS]`), matching the CLI
parser's regex.

- **Step side.** `s` is the step's *raw* line text minus the `N. ` list
  prefix. On the client and server that is exactly what
  `extractSteps`-style helpers already produce (they strip only the number
  prefix); in the CLI parser it is the raw-scan line — **not** the
  `extractPlainText` output stored for execution, which strips inline
  markdown (`**Login**` → `Login`) and would make the CLI disagree with
  every other path.
- **Heading side.** `s` is the raw heading text after `### `.

Consequences worth stating: `1. **Login**` does not invoke `### Login`
anywhere (and would invoke `### **Login**` — raw-equal); a
`[no-hooks]`-prefixed call still resolves (the marker is stripped by the
derivation, and its hook-skipping meaning is preserved); trailing
punctuation is a near-miss, not a call. A shared fixture table pins the
rule across every implementation — parser/expander, runner-core, and the
host/webview copies (canonical home: see the runtime spec §9).

### Semantics

- **Expansion is parse-time and inline**, identical to skills: the runner
  sees a flat list of steps. A section invoked twice expands twice.
- **Scope transparency.** A section shares the scope of the frame that
  *defines* it:
  - A **test-file** section body gets no scope pass at all — no `{{param}}`
    pre-interpolation, no namespacing, no aliasing. `{{name}}` placeholders
    and `[store as: X]` behave exactly as if the body steps were written at
    the call site; a `[store as:]` inside a section is visible to every
    later step of the test.
  - A **skill-file** section body belongs to that skill instance's scope:
    when a skill is expanded, the per-instance transforms `applySkillScope`
    applies to the body steps (caller-arg interpolation, `__skill<N>_*`
    internal renaming, output aliasing) are applied to the skill's section
    bodies as well — and the internal-name discovery pass scans section
    bodies alongside `skill.steps`, so an internal variable used only
    inside a section still gets namespaced. Without this, a skill's section
    would leak `[store as:]` names into test scope and miss its caller's
    parameter values, breaking skill isolation. Implementation notes: this
    happens per invocation — after the `skillCache` lookup, exactly where
    `applySkillScope` runs today — and must produce **fresh transformed
    copies** of the section bodies (the cached `ParsedSkill` is shared
    across invocations and must never be mutated, or a second invocation
    inherits the first's arguments).
- **`[input:]` / `[interactive]` inside a body.** Same carve-out that
  already applies to skill bodies: on the CLI path they prompt exactly as
  at the call site; on the server/TestBench path the client's block
  splitter sees only main-flow lines, so a body-line `[input:]` rides the
  expansion to the server and is auto-skipped ("not supported in API
  mode") like any server-side `[input:]` today. Scope transparency is
  about *variables*, not about the transport's interactivity limits.
- **Hooks.** `beforeEach` / `afterEach` wrap each *expanded* body step, as
  with skills. A `[no-hooks]` prefix on the *invocation* opts the entire
  expanded body out. `[no-hooks]` on an individual body step is stripped
  and ignored, matching the current — silently ignored — behaviour of
  `[no-hooks]` inside skill bodies; the stripping happens in the CLI
  parser *and* in the expander when it inlines a body (the server path
  receives markers verbatim in the `sections` payload, and without the
  expander-side strip the literal `[no-hooks]` text would reach the AI
  there but not on the CLI — an execution-text divergence). Hook entries
  themselves never resolve to sections (see Non-goals).
- **Errors and warnings.**
  - Duplicate section name in one file (case-insensitive) → parse error.
    (TestBench-native additionally refuses to *run* such a file client-side
    — the wire format cannot represent duplicates; see the runtime spec.)
  - Reserved / `[`-prefixed / `{{`-containing / empty section name → parse
    error.
  - Section invoked but its body has zero steps → expansion error naming
    the section and file.
  - Section defined but never invoked → **expansion-time warning**
    (`logger.warn` on both the CLI and server paths), not an error. The
    server emits it only when expanding a full batch — subset batches
    (breakpoint continuations, `[input:]` splits) stay silent and rely on
    the editor diagnostic and the next full run (runtime spec §4.3). For a
    *skill's* internal dead section, the scan lives in the **expander**
    (not skill parsing — the server clears the skill cache every batch, so
    a parse-time warning would re-fire per batch): it runs on first entry
    into each skill file within one `expandSkills` call, gated by the same
    `warnDeadSections` flag and deduped within the call — so one warning
    per file per expansion pass, regardless of invocation count. "Invoked" is
    a flat textual scan: any step anywhere in the same file (main flow or
    any section body) whose match text equals the name counts as a call
    site, even if that call site is itself inside a never-invoked section,
    and hook entries never count. This is the author's rename-drift
    tripwire: renaming a section without updating its call site immediately
    produces the warning (and the orphaned call silently degrades to an AI
    step — the warning is what surfaces it).
  - Cycles (`A → B → A`, a section invoking itself, or mutual
    skill/section cycles) → expansion error via the existing guard.

### Why bare-name + `###` (alternatives considered)

- `[section: name]` token: explicit, but a second keyword to learn and a
  call-site edit on every promotion to a skill. Rejected for ergonomics —
  the whole point of sections is that the main flow reads as prose.
- Reusing `[skill: name]` with local-first resolution: one token, but it
  blurs the skill/section distinction, introduces shadowing questions, and
  makes `[skill:]`'s greedy commit-and-throw behaviour
  ([stories/skill-call-syntax.md](skill-call-syntax.md)) ambiguous between
  "typoed skill" and "meant a section". Rejected.
- `## Name` (H2) definitions: collides with the reserved-H2 namespace,
  breaks the "one `## Steps` span" assumption in six client-side parsers,
  and any existing prose H2 could silently become a definition. `###` inside
  `## Steps` is strictly cleaner: the namespace is verified unused, and the
  markdown outline nests sections under Steps where they belong.

The bare name is the one deliberate risk: a typo in a call site is not an
error — it's a plausible AI instruction. Three mitigations ship with the
feature: the dead-section warning above, the report provenance badge (a
resolved call's steps are visibly badged; an unresolved one isn't), and the
editor affordances in the authoring spec (resolved calls render as links;
completion offers section names).

## Design

### Parser — [src/parser/markdown.ts](../src/parser/markdown.ts)

`parseSections` currently dispatches on heading depth 1 and 2 and lets
depth ≥ 3 fall through with `currentSection` unchanged. Change: when
`currentSection === 'steps'` and a depth-3 heading arrives, switch into
"collecting section" mode; subsequent list tokens accumulate into that
section instead of `steps`. A depth-3 heading anywhere else keeps today's
no-op behaviour. Name validation (reserved / `[`-prefixed /
`{{`-containing / empty / duplicate) happens here.

New parsed shape (in [src/parser/types.ts](../src/parser/types.ts)):

```ts
export interface ParsedSection {
  /** Name from the raw heading line (original casing, trimmed). */
  name: string;
  /** 1-based line of the `### Name` heading in the raw file. */
  headingLine: number;
  /** Body steps, cleaned exactly like main-flow steps (for execution). */
  steps: string[];
  /** Raw body-step line text (number prefix stripped, trimmed) — the
   *  match-side input for nested bare-name calls. Parallel to `steps`. */
  rawSteps: string[];
  /** 1-based raw-file line per body step, parallel to `steps`. */
  stepLines: number[];
}

// ParsedTest gains:
sections: Record<string, ParsedSection>;   // keyed by lowercased raw name
rawSteps: string[];                        // main flow, match-side input
sourceSections: (string | null)[];         // post-expansion, parallel to steps

// ParsedSkill gains:
sections: Record<string, ParsedSection>;
rawSteps: string[];                        // skill body, match-side input
```

`ParsedSkill.rawSteps` is not optional polish: the expander recursion runs
over `applySkillScope` *output* — transformed, `extractPlainText`-normalized
strings — so without the raw parallel a formatted skill-body line
(`2. **Login**`) would wrongly match the skill's `### Login`, breaking the
match rule exactly where it's hardest to notice.

Body steps run through the same `extractSteps` used for the main flow, so
`[tool:]` parsing and `[no-hooks]` stripping behave uniformly (the parallel
`toolCalls` array is already re-derived post-expansion, and `skipHooks`
handling moves to origin-mapping — below). The skill-file parse-time
env/data pass (`applySkillEnvDataInterpolation`, and its no-envCtx warning
fallback) currently maps `parsed.steps` only; it must map each
`sections[*].steps` as well — but explicitly **not** `rawSteps`, which
stay raw as the match side — or a skill's `${env.X}` / `${<source>.X}`
references resolve in its main body and survive as literals inside its
section bodies, failing later with a wrong-file error or shipping raw to
the AI.

**Line attribution** (`extractStepLinesFromRaw`) is the delicate part. The
raw two-pass scan currently returns one flat array of numbered-item lines in
the `## Steps` span. It becomes section-aware: within the Steps span, lines
before the first depth-3 heading are main-flow step lines; each depth-3
heading starts a new bucket `{ name, headingLine, stepLines, rawSteps }`.
The marked-token pass and the raw pass walk the document in the same order,
but index alignment must now hold **by construction, not by trim**: once
`rawSteps[i]` is the match-side input, a one-off shift flips call/non-call
decisions. The section-aware raw scan therefore replicates `extractSteps`'
cull rules (items whose cleaned text is empty — e.g. a bare `1.` or a
marker-only `1. [no-hooks]` — are dropped from *both* arrays). Perfect
replication is impossible in the general case (the raw scan sees text,
marked sees rendered tokens — a numbered line inside a fenced code block,
or `1. **[no-hooks]**`, diverge), so the hard equal-lengths assert applies
**only to section buckets and to the main flow of files that define
sections** — files a new feature is being written into. Sectionless files
keep today's lenient warn-and-trim, preserving Goal 4 for every existing
file. Unit tests pin the divergent cases (blank numbered items,
marker-only items, formatted markers, numbered lines in code fences,
prose between steps, `####` noise inside a body).

### Expander — [src/skills/expander.ts](../src/skills/expander.ts)

`expandSkills`' positional signature
(`steps, skillsDir, envCtx?, callerFilePath?, sourceLines?`) grows a
trailing options argument `{ sections?, rawSteps?, warnDeadSections? }`
(the last defaults to `true`; the server's cache-hash expansion passes
`false` and its execution site derives it from batch shape — runtime spec
§4.3 — so one dead section doesn't warn per batch per expansion site), and
`skillsDir` becomes optional (`string | undefined`): section-only projects
have no skills directory. A `[skill:]` call encountered with no `skillsDir` throws
a clean "no skillsDir configured" error instead of today's silent
raw-text-to-AI pass-through (see Migration). Call-site audit:
`parseTestFile`'s steps site passes `sections` + `rawSteps`; its four hook
sites and the `defaultHooks` expansion in
[src/runner/hooks.ts](../src/runner/hooks.ts) deliberately pass neither
(hooks never resolve to sections); the server's two sites pass the
request's sections (see the runtime spec). `parseTestFile`'s expansion
gate widens to match the server's: expand when `skillsDir` is set **or**
the file defines sections (today's `if (options.skillsDir)` guard would
otherwise leave library callers who omit `skillsDir` with unexpanded
bare-name calls; the CLI itself always passes the `./skills` default, so
this only affects direct `parseTestFile` consumers).

Resolution order per step in `expandRecursive`:

1. `parseSkillCall(step)` — unchanged (any `[skill:` line is committed).
2. **New:** if the step's match text (derived from `rawSteps[i]`, falling
   back to the step string itself on the server path, where steps arrive
   raw) equals a key in the current file's section map → section call.
3. Otherwise: inline step, unchanged.

`ExpandContext` gains the current file's `sections` map, `rawSteps`, and
`filePath`; recursing into a *skill* swaps in that skill's own map and
`rawSteps` — the sections **scoped for this invocation**: the same
rename/interpolation/alias maps `applySkillScope` builds for the skill's
steps are applied to fresh copies of its section bodies (and `usedNames`
discovery scans section bodies too, per Semantics). Recursing into a
*section* keeps the containing frame's map (a section's body may call
sibling sections; the match side uses the section's own `rawSteps`).

Section expansion mirrors the skill branch minus scope handling:

- New frame: `kind: 'section'`, `uri` = containing file, `invocationLine` =
  the call step's line, `skillName` = section name (field reused; see Open
  questions), no `inputs`, no `outputs`. `ExpandedFrame.kind` widens to
  `'test' | 'skill' | 'section'`.
- Body steps recurse with the *same* depth/cycle guard as skills. Cycle keys
  must not collide across namespaces or files: skills stay keyed by name;
  sections are keyed `section:<absolute-file-path>#<lowercased-name>`.
- Origins for body steps carry `skillFilePath` = containing file and
  `skillLine` = body line — exactly the fields the server already uses to
  compute per-step source lines, match `startAt`/`endAt` anchors, and route
  breakpoints. (The `skill*` field names become slightly a misnomer; kept in
  v1 to avoid a cross-cutting rename.)
- `SkillExpansion` gains `sourceSections: (string | null)[]`, parallel to
  `sourceSkills`. It tags each step with the name of the section the test
  author can see: the outermost section frame that sits **outside any skill
  frame** (i.e. sections of the root file). Steps from a *skill's internal*
  sections get `sourceSections = null` — the skill badge already names what
  the author wrote, and surfacing skill-private section names in a test
  report would be noise. Both tags can be set at once (a skill invoked from
  inside a test-file section).

**`skipHooks` alignment fix.** `parseTestFile` currently pads/truncates the
pre-expansion `skipHooks` array to the expanded length — which misaligns it
whenever any invocation expands to more or fewer than one step. Since
sections make multi-step expansion the common case, replace the pad with the
same origin mapping already used for `stepLines`:
`skipHooks = origins.map(o => preExpansion[o.inputIndex] ?? false)`. This is
what makes "`[no-hooks]` on the invocation covers the whole body" true — and
it incidentally corrects the same latent misalignment for skills (a
behaviour change for existing files; see Migration).

### Runner, server, report

- **Runner** ([src/runner/test-runner.ts](../src/runner/test-runner.ts)):
  mechanical only — thread `ParsedTest.sourceSections` into `StepResult`s
  the same way `sourceSkills` is threaded today. No control-flow changes:
  sections are gone by the time the runner sees steps, and the
  conditional-step grouper ("If … / When prompted …" prose steps) operates
  on the expanded list, so conditional steps inside a section body behave
  as they do inside a skill body.
- **Server** ([src/server/session-manager.ts](../src/server/session-manager.ts)
  and [src/server/api-server.ts](../src/server/api-server.ts)):
  the step loop, frame transitions, `startAt`/`endAt` anchoring, and
  breakpoint checks all read origins/frames and work unchanged for section
  frames, with the adjustments specced in the runtime companion — notably:
  the request gains a `sections` field which **api-server must explicitly
  forward** (its `StepRequest` construction is a per-field allow-list; a
  type-only change silently drops the field), the sections map threads
  into **both** `expandSkills` call sites (execution *and* cache-bundle
  hashing), the "skip test-file breakpoints" rule narrows to *root-frame*
  steps, the `startAt`/`endAt` anchor gains a same-file guard, and
  `StepResult.sourceSection` is derived from frames by an
  `outermostSectionName` walk (the frame-based twin of the expander rule
  above) at both places `sourceSkill` is derived today.
- **Report** ([src/report/generator.ts](../src/report/generator.ts)):
  `StepResult` gains `sourceSection?: string`; `renderStep` shows a section
  chip alongside (not instead of) the existing skill chip, with matching
  CSS in [src/report/template.ts](../src/report/template.ts) /
  `templates/report.html`. Flat rendering is unchanged.
- **CLI step lines:** `parseTestFile` already re-aligns `stepLines` through
  `origins.inputIndex`, so CLI reports point section-expanded steps at their
  invocation line, same as skills.

## Testing

- **Parser unit tests:** section capture (names, casing, heading lines,
  body lines, raw text); main flow ends at first `###`; prose inside bodies
  is inert, and `####`-with-text makes every numbered item under it inert; hashes-only lines (`###`, `####`,
  `#######`) inside `## Steps` throw the empty-name error at every depth;
  duplicate / reserved / `[`-prefixed / `{{`-containing names throw;
  `###` outside `## Steps` remains a no-op; a file without `###` parses
  byte-identically to today (regression guard over existing fixtures).
- **Expander unit tests:** the shared match-table fixture (exact,
  case-insensitive, trimmed; `**Login**`, backticked, trailing-period, and
  `[no-hooks]`-prefixed rows; a formatted call site *inside a skill body*);
  multi-call expansion; section → section, section → skill, skill-file
  sections **with scoping** (caller args interpolated into section bodies,
  internals namespaced — including an internal used *only* in a section
  body, outputs aliased) and **without cached-object mutation** (the same
  skill invoked twice with different args: each invocation's section bodies
  carry its own values); test-file sections unscoped (`[store as:]` keeps
  its name); a skill with `dataSources` whose `${source.X}` reference
  appears *only* inside a section body resolves at parse time (the
  env-data pass covers section bodies); `sourceSections` tagging incl. the
  skill-internal-section null rule; cycles (self, mutual, skill↔section)
  throw; empty invoked section throws; dead-section warning fires on the
  flat-scan rule (and does not
  fire for a section called only from another section); hook entries never
  resolve to sections; `skipHooks` origin mapping (invocation-level
  `[no-hooks]` covers the body — for sections *and* for a multi-step
  skill); `[skill:]` with no `skillsDir` throws the new clean error;
  `parseTestFile` with sections but no `skillsDir` still expands.
- **Integration:** new fixture `fixtures/tests/sections-demo.md` (calls a
  section twice, section calls a skill) run through
  `parseTestFile({ skillsDir })` asserting the expanded step list, origins,
  frames, and `sourceSections`; report-generation tests asserting the
  section badge on both the CLI-shaped and server-shaped result paths.

## Docs

- `SPEC.md` — add `### <Name>` to the Sections table and a "Sections"
  subsection under the test-file format; document the match rule and the
  reserved-name rules.
- `README.md` — extend "Test File Format" with a sections example; add the
  missing `## Skills` section the `#skills` anchor already points at, and
  describe sections beside it.
- `templates/init/tests/` — add a `sections-demo.md` template modelling the
  feature (mirrors the fixture).
- Companion-spec updates on the TestBench side are enumerated in the
  runtime spec (§11).

## Migration

Additive except four edges:

1. A markdown test/skill file with a `###` heading *inside* `## Steps`
   followed by numbered items currently runs those items as main-flow
   steps; they become a (probably never-invoked) section — the steps stop
   running and a dead-section warning appears. No markdown test/skill file
   in this repo does that (verified); external suites get a release note,
   and the warning makes the failure mode loud rather than silent.
2. The `skipHooks` origin-mapping fix: `[no-hooks] [skill: multi_step]`
   previously applied (misaligned) to roughly the first expanded step; it
   now covers the whole expanded body — the behaviour the hooks story
   always described.
3. For any expansion that now runs where none ran before — a server
   request carrying a non-empty `sections` map, or a direct
   `parseTestFile` call without `skillsDir` on a file that defines
   sections: a `[skill:]` step previously shipped as raw text to the AI
   (no expansion at all); under the widened gates it becomes an explicit
   error naming the missing `skillsDir`. Sectionless requests/files
   without `skillsDir` keep the legacy raw pass-through, and the CLI
   always passes its `./skills` default, so in practice this touches
   library consumers and sectioned server requests only.
4. Per-step caching on subset batches (breakpoint continuations,
   `[input:]`/`[interactive]`-split blocks, selection runs) is disabled
   for steps inside skill/section frames — see runtime spec §4.3. For
   existing *skill* projects this trades occasional (and occasionally
   wrong — the frame-id collision) cache hits on continuation batches for
   guaranteed-correct misses.
5. TestBench's run-selection resolution: a cursor/selection entirely past
   the last main-flow step currently resolves to "run everything"; it
   becomes an explicit refusal (runtime spec §5) — a pre-existing silent
   footgun fixed because section bodies would have made it the *common*
   gesture, and it applies to non-sectioned files too.

## Status

Three code-grounded review rounds (four reviewer passes) are folded into
this revision. The load-bearing decisions they forced: the **single
match-text derivation** (the marked-token text diverges from what clients
and the server see — and `ParsedSkill.rawSteps` exists because the skill
recursion otherwise only sees transformed text), the **skill-instance
scoping of skill-file sections** with fresh-copy semantics (no
cached-`ParsedSkill` mutation), **expansion-time flat-scan semantics for
the dead-section warning**, the **hooks-never-resolve rule**, the
`{{`-in-name ban, the **v1 refusal of re-run flows for skills that define
internal sections** (line anchors need an ancestor-line redesign there),
and the server-side seam work detailed in the runtime spec (api-server
field forwarding + malformed-payload 400, cache rules, anchor guard).

## Open questions (deferred)

- **Per-section parameters/outputs** via `#### Parameters` under a section
  heading — deferred until a concrete need; shared scope covers the known
  cases and skills cover the isolation cases.
- **Field renames** (`ExpandedStepOrigin.skillFilePath` / `skillLine`,
  `ExpandedFrame.skillName`) to origin-neutral names — mechanical, touches
  server + runner-core + native; do it as a standalone cleanup, not inside
  this feature.
- **"Extract section to skill" refactor tooling** in TestBench — natural
  follow-on once both features are stable.
- **Honouring `[no-hooks]` on individual body steps** (today discarded for
  skill bodies too) — revisit if anyone asks; needs expander-level plumbing
  of per-body-step flags.
- **Re-run-with-variables / debug-after-stop for skills that define
  internal sections** — v1 refuses these flows for such skills (runtime
  spec §7): the `startAt`/`endAt` line anchors would need
  top-level-ancestor-line semantics to be safe once a skill file contains
  section bodies. Deferred with the anchoring redesign.
