# Inline sections: the frozen cross-package contract

**Status: frozen.** This document is the single source for the shapes and
rules that more than one package implements. Change it only by editing this
file first and re-reviewing — never by editing an implementation until it
passes, and never by editing a fixture row to make a test go green.

Companions: [test-script-sections.md](test-script-sections.md) (grammar and
semantics — the *why* for everything below),
[inline-sections-runtime.md](../testbench-native/stories/specs/inline-sections-runtime.md),
[inline-sections-authoring.md](../testbench-native/stories/specs/inline-sections-authoring.md).

Where this document and a companion spec disagree, **this one wins** — the
divergences are called out inline as `Supersedes:` notes.

## 1. Why this document exists

Inline sections cross four packages that share **no compiled types**:

- the CLI parser/expander (`src/`)
- `runner-core/` (bundled into both extensions)
- the server (`src/server/`) — which does **not** import `runner-core`; it
  hand-mirrors `FrameInfo` in
  [session-manager.ts](../src/server/session-manager.ts) and the `## Steps`
  span scanner in [markdown.ts](../src/parser/markdown.ts)
- the two VS Code extensions, plus five hand-maintained copies of the span
  scanner (tracked as [issues/035](../issues/035-step-line-span-parser-duplicated-six-times.md))

So the wire shape for `sections` is written out **twice** with nothing linking
the copies, and the match rule is implemented **six times**. Every one of those
is a place two implementations can silently disagree about whether a given step
is a section call — and disagreement means the same file executes differently
depending on how it was launched.

The fixtures in `fixtures/sections/` are the drift guard. Copy the shapes below
verbatim; assert against the fixtures from every package.

## 2. The match rule

One derivation, applied to both sides of the comparison:

```ts
/** Verbatim from src/parser/markdown.ts — every reimplementation must carry
 *  the /i flag and the anchor. */
const NO_HOOKS_MARKER = /^\[no-hooks\]\s*/i;

function matchText(s: string): string {
  return s.replace(NO_HOOKS_MARKER, '').trim().toLowerCase();
}
```

Non-negotiables:

- **`toLowerCase()`, never `toLocaleLowerCase()`.** The latter follows the host
  locale; a Turkish-locale client and a C-locale server would disagree about
  dotted/dotless I. Three fixture rows pin this from both directions.
- **Strip, then trim, then casefold — in that order.** The strip is anchored at
  `^`, so leading whitespace defeats it. This cannot occur on a real document
  (both sides arrive already trimmed), but the order is pinned so six
  implementations don't each pick one.
- **Ends only.** `trim()` does not collapse internal whitespace runs.
- **Heading side** is the raw text after `### `, trimmed.

### 2.1 The match input — one rule, both paths

The step side is the **raw** line minus the `N. ` prefix — *not*
`extractPlainText` output, which strips inline markdown in some list layouts
(§2.3) and would make the CLI disagree with every other path.

But `rawSteps` only exists on the CLI parse path. The server receives steps
already in raw/instruction form and has no parallel array. So the rule is
stated once, for every step list, at every level:

```ts
/** The match-side input for step i of ANY step list — main flow or section
 *  body, CLI or server. Never extractPlainText output. */
matchInput(list, i) = list.rawSteps?.[i] ?? list.steps[i]
```

This applies to the top-level `opts.rawSteps` **and** to each
`SectionDefs[key].rawSteps` when resolving a bare-name call nested inside a
section body. An implementation that reads `steps[i]` directly is wrong even
where the two happen to be equal.

*Supersedes:* [test-script-sections.md](test-script-sections.md) scopes its
"falling back to the step string itself on the server path" clause to the
top-level array only. The fallback applies at every level.

### 2.2 Resolution order and the two carve-outs

`matchText` is pure text equality. Two rules sit *outside* it and are stated
here because more than one package implements each:

- **Bracket tokens win.** A step parsing as `[skill:]`, `[tool:]`, `[input:]`
  or `[interactive]` is claimed first and is never a section call, however its
  text compares. Three implementations depend on this: the expander's
  resolution order, `buildSectionIndex` (such lines enter neither `calls` nor
  `nonCallSteps`), and the near-miss diagnostic (`1. [skill: login]` must not
  warn about a section named `Login`).
- **Hooks never resolve.** `## Hooks` entries and project `defaultHooks` are
  expanded with **no sections map** — a hook entry equal to a section name
  stays an ordinary AI step — and a hook entry never counts as a call site for
  liveness (§2.4). Enforced by call-site audit: `parseTestFile`'s four hook
  sites and [src/runner/hooks.ts](../src/runner/hooks.ts)'s `defaultHooks`
  expansion deliberately pass neither `sections` nor `rawSteps`.

### 2.3 The tight-list trap — read before writing the raw-vs-plain test

`extractPlainText` ([markdown.ts](../src/parser/markdown.ts)) strips inline
markdown **only for loose lists** (blank lines between numbered items). For a
*tight* list — which every real fixture and every example in the story uses —
`item.tokens[0]` is a `text` token and the function short-circuits on
`token.text`, returning the raw inline source unchanged.

Measured against the repo's marked 18.0.2:

| List style | `1. **Login**` → | `` 1. `Login` `` → |
|---|---|---|
| tight | `**Login**` | `` `Login` `` |
| loose | `Login` | `Login` |

Consequence: the obvious by-construction test — a skill body line
`2. **Login**` that should not match `### Login` — **passes whether or not the
implementation reads the correct array**, because in a tight list
`steps[i] === rawSteps[i]`. It is a no-op guarding the one hazard the match
table cannot express.

**Use this discriminator instead**, which does not depend on list looseness:

```markdown
# a skill invoked with target="Login", defining its own `### Login`
## Steps
2. {{target}}
```

`applySkillScope` rewrites `steps[i]` to `Login` (which *would* match the
skill's `### Login`) while `rawSteps[i]` stays `{{target}}` (which must not).
An implementation reading `steps[i]` resolves a call that should not exist.
Assert it **through `parseTestFile`** — calling `expandSkills` with hand-built
arrays bypasses the transform that causes the bug.

*Supersedes:* [inline-sections-runtime.md](../testbench-native/stories/specs/inline-sections-runtime.md) §9
lists "a formatted call site inside a skill body" among the required
match-table rows. It is deliberately **absent** from `match-table.json` — a
pure text table structurally cannot express it — and lives in the
parser/expander suite as the `{{target}}` scenario above.

### 2.4 Liveness — one rule, two consumers

"Invoked" is a **flat textual scan**: any step anywhere in the same file (main
flow or any section body) whose match text equals the name counts as a call
site — **even if that call site is itself inside a never-invoked section** —
and hook entries never count.

Two implementations must agree exactly: the expander's dead-section
`logger.warn` (gated by `warnDeadSections`) and the authoring
`Section "X" is never used` diagnostic. The authoring spec asserts they "can
never disagree about liveness"; this rule is what makes that true.

### 2.5 Name validation — one list, three implementations

A section name is refused when it:

```ts
const RESERVED = new Set(['steps', 'config', 'parameters', 'outputs', 'hooks']);

RESERVED.has(name.trim().toLowerCase())   // reads like a second `## Steps`
  || name.trim().startsWith('[')          // bracket parsers claim it first
  || name.includes('{{')                  // see the §3.1 interpolation note
  || name.trim() === ''                   // empty, incl. hashes-only headings
  // plus: duplicate by matchText(name) within one file
```

Three enforcement points, same list: the **CLI parser** raises a parse error;
**testbench-native's `runStepBlock` pre-flight** refuses the run before a
request is built; the **authoring diagnostics** mirror each as an Error row.

## 3. Frozen type shapes

### 3.1 Parser (`src/parser/types.ts`)

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
sections: Record<string, ParsedSection>;   // keyed by matchText(name)
rawSteps: string[];                        // main flow, match-side input
sourceSections: (string | null)[];         // post-expansion, parallel to steps

// ParsedSkill gains:
sections: Record<string, ParsedSection>;
rawSteps: string[];                        // skill body, match-side input
```

**Cull rule.** An item is dropped from `steps`, `rawSteps` **and** `stepLines`
together when its text is empty after the `N. ` strip and after the
`[no-hooks]` strip. A bare `1.` and a marker-only `1. [no-hooks]` are both
culled, from both arrays, by both passes — the section-aware raw scan
replicates `extractSteps`' cull so the parallel arrays stay aligned by
construction.

**Skill-section scoping — no transform touches `rawSteps`.** Both transforms
that act on a skill's section bodies map `steps` only:

| Transform | When | `steps` | `rawSteps` |
|---|---|---|---|
| `applySkillScope` (aliases, `__skill<N>_` renames, caller-arg interpolation) | per invocation, on **fresh copies** | ✅ | ❌ |
| `applySkillEnvDataInterpolation` (`${env.X}`, `${source.X}`) | once at parse time | ✅ | ❌ |

**The match side is always the text as authored.** Section resolution must be
decidable from the file alone, because the authoring layer — go-to-definition,
document links, the "never used" diagnostic — has nothing else to work with.

Matching post-interpolation would let `1. {{target}}`, invoked with
`target="Login"`, dispatch to `### Login`. That call site would render with no
link and its target would be reported dead, while the runtime called it
anyway: exactly the editor/runtime divergence this feature exists to remove.
So it is refused, and the §2.3 discriminator is what pins the refusal.

Renames cannot matter here even in principle: they rewrite only `{{X}}`
placeholders and `[store as: X]` directives, and a section name may contain
neither (`{{` and a leading `[` are both refused at parse time), so no rename
can create or destroy a match.

*Note:* this supersedes the language story's stated rationale for the
`{{`-in-name ban ("the call would silently stop matching after
interpolation") — with an untransformed match side, a `{{`-containing name
would in fact match consistently. Keep the ban anyway: a name that looks like
it interpolates but doesn't is a trap, and banning it keeps one rule instead
of an exception.

`usedNames` discovery scans the skill's `steps` **and** every
`sections[*].steps`, so an internal variable used only inside a section body
still gets namespaced. Never mutate the cached `ParsedSkill` — transform fresh
copies, or a second invocation inherits the first's arguments.

### 3.2 The wire shape — written out twice, identically

Once as `StreamStepsRequest.sections` in
[runner-core/src/api-client.ts](../runner-core/src/api-client.ts), once as
`StepRequest.sections` in
[src/server/session-manager.ts](../src/server/session-manager.ts):

```ts
/**
 * Inline section definitions from the test file, keyed by `matchText(name)`
 * (see the contract §2). Required whenever `steps` (or `fullSteps`) may
 * contain bare-name section calls — the server cannot read the file, the
 * buffer may be unsaved. Line numbers are 1-based in the same document as
 * `sourceLines`. Requires `testFilePath` (section frames and cycle keys
 * derive from it).
 */
sections?: Record<string, {
  /** As authored, casing preserved. Display only — never re-derive the key
   *  from it; the server uses the incoming keys verbatim. */
  name: string;
  headingLine: number;
  /** The raw line with /^\s*\d+\.\s+/ removed and .trim() applied, with
   *  `[no-hooks]` markers preserved verbatim. Empty-after-strip items are
   *  culled (§3.1), so this never contains a marker-only entry. */
  steps: string[];
  stepLines: number[];   // parallel to steps
}>;
```

Note the deliberate asymmetry with `ParsedSection`: the wire shape has **no
`rawSteps`**. The server's incoming steps are already the raw/instruction
form, so the parallel isn't needed — the §2.1 fallback covers it. Do not add
it to the wire.

`steps` carries `[no-hooks]` markers **verbatim**. The expander strips them
when inlining a body — the CLI parser strips at parse time, so without the
expander-side strip the literal marker text would reach the AI on the server
path only.

**Empty means absent.** One predicate, used by every gate:

```ts
const hasSections = (req) => !!req.sections && Object.keys(req.sections).length > 0;
```

`{}` is truthy in JS, and the specs' informal gates (`skillsDir ||
request.sections`) are true for it. Four call sites must use the predicate:
the client's omit decision, api-server's 400 validation, session-manager's
expansion gate, and `chooseCacheHashSource`'s third argument. Getting this
wrong silently changes behaviour for **every existing sectionless run**.

**The type change alone does nothing.**
[api-server.ts](../src/server/api-server.ts) builds `StepRequest` from an
explicit per-field allow-list; an unlisted field is silently dropped. This is
the seam that once dropped `envName`. Validation lives in the HTTP layer, not
the session manager:

| Condition | Result |
|---|---|
| non-empty `sections` without `testFilePath` | **400** |
| entry not an object; `name` not a string; `headingLine` not a number; `steps`/`stepLines` not arrays; `steps.length !== stepLines.length` | **400**, *not* a silent drop |
| `sections: {}` | treated as absent — legacy path, no 400 |
| invoked section with an empty body; cycles | expander errors, not 400s |
| duplicate names | unrepresentable (JSON collapses keys); the client's pre-flight owns this |

The 400-on-malformed is a deliberate departure from the house pattern
(`breakpointsByUri` shape-checks and silently drops): dropping degrades to
bare-name steps shipped to the AI, which is the silent double-execution class
this feature exists to eliminate.

### 3.3 Frame kind

`ExpandedFrame.kind` (expander) and `FrameInfo.kind` (protocol, plus the
hand-mirrored copy in `session-manager.ts`) all widen:

```ts
kind: 'test' | 'skill' | 'section'
```

- `uri` is the file that **defines** the section — the test file for a
  test-file section, the **skill** file for a skill-internal one (matching
  `ExpandedFrame.uri`'s existing "file containing this frame's steps").
  Runtime spec §7's "`uriOfStep` returns the test file for every section
  frame" is true only of *top-level* section frames, which is the only case
  that flow handles.
- `skillName` carries the **section** name. The enclosing skill's name is on
  the nearest ancestor frame with `kind === 'skill'`.
- **`id` is unique within one `expandSkills` call**, section frames included —
  they share the skill counter. (This was not true before
  [#12](https://github.com/pkent/ai-ui-automation/pull/12): the counter was
  copied by value into nested recursions, so a nested frame and a later
  sibling collided. Assert uniqueness; don't assume it.)

### 3.4 Expander input (`SectionDefs`)

The expander accepts **one** section-map type, satisfied by both producers —
the parser's `ParsedSection` and the wire shape:

```ts
type SectionDefs = Record<string, {
  name: string;
  headingLine: number;
  steps: string[];
  stepLines: number[];
  /** Present on the CLI parse path, absent on the server path. Resolution
   *  uses the §2.1 fallback, so absence is normal, not degraded. */
  rawSteps?: string[];
}>;
```

`ParsedSection` (which requires `rawSteps`) is assignable to it; so is the
wire entry. Typing `opts.sections` as `Record<string, ParsedSection>` would
make the server's own `request.sections` unassignable — the one caller the
runtime spec names explicitly.

### 3.5 `SectionIndex` (`runner-core/src/section-index.ts`)

Per the plan this lives in runner-core, **not** in the extension host copy as
[inline-sections-authoring.md](../testbench-native/stories/specs/inline-sections-authoring.md) §3
says — it is built entirely on `extractSections`/`classifyLines`, its consumers
already import runner-core, and keeping it here removes a file collision
between the runtime and authoring work.

```ts
interface SectionIndex {
  /** keyed by matchText(name). Empty-name headings NEVER enter this map. */
  sections: Map<string, { name: string; headingLine: number; stepCount: number }>;
  /** Every step line resolving to a section — main-flow AND body lines.
   *  `nameStart` is the 0-based column where the match text begins (past
   *  the `N. ` prefix and any `[no-hooks] ` marker). Bracket-token lines
   *  appear here never (§2.2). */
  calls: { line: number; name: string; nameStart: number }[];
  /** Plain-text steps resolving to nothing; bracket-token lines excluded. */
  nonCallSteps: { line: number; matchText: string; nameStart: number }[];
  /** Headings that lost to an earlier definition (the Map collapses them),
   *  plus EVERY empty-name heading, under name "". */
  duplicates: { name: string; headingLine: number }[];
}
```

## 4. Frozen signatures

```ts
// src/skills/expander.ts — the opts arg is TRAILING and OPTIONAL so all
// existing positional call sites compile unchanged. skillsDir becomes
// optional: section-only projects have no skills directory.
export async function expandSkills(
  steps: string[],
  skillsDir: string | undefined,
  envCtx?: EnvDataContext,
  callerFilePath?: string,
  sourceLines?: number[],
  opts?: {
    sections?: SectionDefs;          // §3.4 — NOT Record<string, ParsedSection>
    rawSteps?: string[];
    /** defaults to true; false on the server's cache-hash expansion */
    warnDeadSections?: boolean;
  },
): Promise<SkillExpansion>;

// runner-core/src/step-lines.ts
// Emits empty-name entries (§5 rule 3) in document order with their bodies
// attached — monaco's refusal and native's pre-flight both depend on seeing
// them. Applies the §3.1 cull rule: an item empty after the `N. ` strip and
// the `[no-hooks]` strip is dropped. (runner-core's existing `extractSteps`
// does NOT cull today; `extractSections` must.)
export function extractSections(
  text: string,
): { name: string; headingLine: number; steps: { line: number; instruction: string }[] }[];

// runner-core/src/section-index.ts
export function buildSectionIndex(text: string): SectionIndex;

// src/server/session-manager.ts — frame-based twin of the expander's
// sourceSections rule: the outermost section frame that sits OUTSIDE any
// skill frame. A skill's own internal sections are never the answer.
// For test -> section A -> skill S -> section B, a step in B yields "A":
// B is skill-private and skipped, but A sits outside every skill frame and
// is what the test author actually wrote. (Only a skill invoked from the
// root flow yields undefined.) This is what keeps the documented
// both-badges case true — a step can carry skill S and section A at once.
function outermostSectionName(
  frameId: string,
  frames: Record<string, FrameInfo>,
): string | undefined;

// src/server/cache-hash-source.ts — third arg widens from "has skillsDir"
// to "has skills OR sections". Callers pass `!!skillsDir || hasSections(req)`
// (§3.2) — never a bare truthiness check on the map.
export function chooseCacheHashSource(
  steps: string[],
  fullSteps: string[] | undefined,
  hasSkillsOrSections: boolean,
): CacheHashSource;
```

`SkillExpansion` gains `sourceSections: (string | null)[]`, parallel to
`sourceSkills`.

## 5. Line kinds

`LineKind` gains two members:

```ts
export type LineKind =
  | 'step' | 'section-heading' | 'section-step'
  | 'frontmatter' | 'heading' | 'prose' | 'blank';
```

**Precondition.** Sections are recognized only under a **depth-2 `## Steps`**
heading. `STEPS_HEADING_RE` accepts `#{2,}`, and every span parser closes the
span at `depth <= headingDepth` — so under a `### Steps` heading a `###` line
*closes the span* rather than landing in it, and no section can be defined.
That matches the CLI, whose `parseSections` dispatches on depth 1 and 2 only.
Rules 3–5 below therefore apply when `headingDepth === 2`.

Classification order inside `classifyLines`, given the Steps span:

1. frontmatter span → `frontmatter`
2. blank → `blank`
3. **in-span and hashes-only** (`/^#{3,}\s*$/`) → `section-heading`, empty name
4. `ANY_HEADING_RE` match → `section-heading` if in-span and depth is exactly
   3, else `heading` (depth ≥ 4 in-span is inert prose per the grammar)
5. in-span and `STEP_LINE_RE` → `section-step` if any `section-heading` was
   seen earlier in the span, else `step`
6. otherwise `prose`

Rule 3 is the one that is easy to skip and expensive to omit: `ANY_HEADING_RE`
demands a non-space after the hashes, so a bare `###` is invisible to it. Left
as prose, the CLI throws its empty-name parse error while TestBench happily
runs the "body" items as main-flow steps — the exact CLI/TestBench divergence
this feature exists to eliminate.

**Body attribution.** A hashes-only line at any depth ≥ 3 **both terminates
the preceding body and opens a new empty-name section.** The grammar's
"a body runs until the next heading of depth ≤ 3" applies to `ANY_HEADING_RE`
headings only — which is why an inert `#### With text` does *not* close a body
(pinned by `classification.md` lines 27→29) while a bare `####` does (pinned by
`classification-hashes.md`). Consecutive hashes-only lines therefore yield one
empty-name section each, not one section with a merged body.

Consumer split (runtime spec §3):

- **main flow only** — `extractSteps`, `resolveRunLines`,
  `classifySelectedSteps`, `nearestStepAtOrBelow|Above`. These are
  runner-core's API.
- **main + body** — `extractStepLineIds`, which exists in **three** files: the
  native host [step-lines.ts](../testbench-native/src/extension/step-lines.ts)
  and both webview `step-lines-inline.js`. runner-core has no such export.
  Already true in all three today (their `findStepsSpan` breaks only on
  depth ≤ headingDepth, so a `###` never ends the span), so this is a
  **preservation requirement pinned by tests**, not an edit.
- **main + body, preserve rows** — `collectVariables` in both
  `variables-panel.js` copies. They scan every numbered line in the span via a
  private `findStepsSpan` and export no `extractStepLineIds`; the requirement
  is only that a section-aware span must not drop body-line rows.

## 6. Fixtures

All under `fixtures/sections/`.

| File | Pins | Consumers |
|---|---|---|
| `match-table.json` | §2, both derived text and boolean, 19 rows | root parser/expander suite; runner-core; native + monaco copy tests |
| `classification.md` + `classification.json` | §5 on the mainstream case; frozen `extractSections` / main-flow output; the dead-section warning | runner-core; root suite (server mirror `extractStepLinesFromRaw`) |
| `classification-edge.md` | raw-scan vs marked-token divergences; the §3.1 cull rule | runner-core; root parser suite (must throw the equal-lengths assert) |
| `classification-hashes.md` | bare `###` / `####` / `#######`; empty-name representation | runner-core; native pre-flight; monaco refusal |

Every fixture carries a `$comment` naming this contract and its consumers.
**Every fixture must have at least two named consumers** — a "shared" fixture
with one consumer is not a drift guard.

`classification.json` keys per-file tables under `files[<name>].lines`.
**Blank lines are omitted** on purpose: trailing-newline and CRLF variance
across checkouts makes a dense array fragile, while a misclassified non-blank
line still shows up as a mismatch. Filter your `classifyLines` output the same
way before comparing.

### Resolution paths

Resolve from `import.meta.url`, never `process.cwd()` — follow the
[tests/cache-dir-parity.test.ts](../tests/cache-dir-parity.test.ts) ↔
[testbench-native/tests/cache-dir-parity.test.js](../testbench-native/tests/cache-dir-parity.test.js)
precedent:

| Consumer | Path from its own directory |
|---|---|
| root vitest (`tests/`) | `../fixtures/sections/…` |
| `runner-core/tests/` | `../../fixtures/sections/…` |
| `testbench-native/tests/` | `../../fixtures/sections/…` |
| `testbench-monaco/tests/` | `../../fixtures/sections/…` |
| `testbench-native/tests/integration/suite/` | `../../../../fixtures/sections/…` |

### Three notes on the fixture location

1. **Deliberate deviation from precedent.** The existing cross-package parity
   fixture lives under `tests/fixtures/`, but `tests/` is the root package's
   vitest root — resolvable from the other three packages only by reaching
   across. `fixtures/` is already the package-neutral home, and the runtime
   spec §9 names `fixtures/sections/match-table.json` explicitly. Keeping it
   here is intentional; don't "fix" it back.
2. **These files are visible to TestBench.** Discovery globs `**/*.md`
   ([test-discovery.ts](../testbench-native/src/extension/test-discovery.ts),
   `DEFAULT_GLOB`), and all three carry a `## Steps` heading, so they appear
   in the test tree like `fixtures/tests/*.md` already do. Two of them are
   *deliberately invalid* and will error if run. That is acceptable and the
   names say so.
3. **Exclude section-defining files from the byte-identical regression
   corpus** — by *property*, not by path. The Goal-4 guard ("a file without
   `###` parses exactly as before") must detect sections
   (`extractSections(text).length > 0`) rather than hard-coding
   `fixtures/sections/`: `fixtures/tests/sections-demo.md` and
   `templates/init/tests/sections-demo.md` land later in this feature, in
   directories the corpus walks.

## 7. Consumption checklist

Before opening any PR that touches sections:

**Match rule**
- [ ] `matchText` is the §2 function character for character — no extra
      normalization, `toLowerCase()` not `toLocaleLowerCase()`
- [ ] section maps are keyed by `matchText(name)`; the server uses incoming
      keys verbatim and never re-derives them from `name`
- [ ] the match input is `rawSteps?.[i] ?? steps[i]` (§2.1) at **every**
      level — top-level array and section bodies, CLI and server
- [ ] the raw-vs-plain guard uses the §2.3 `{{target}}` discriminator, not a
      `**Login**` tight-list test that cannot fail
- [ ] bracket-token lines and hook entries resolve to sections nowhere (§2.2)

**Shapes**
- [ ] the wire shape matches §3.2 exactly, including the absence of `rawSteps`
- [ ] `opts.sections` is typed `SectionDefs` (§3.4), not
      `Record<string, ParsedSection>`
- [ ] `applySkillScope` transforms section `steps` on fresh copies and leaves
      `rawSteps` untransformed; the env/data pass likewise maps `steps` only
      (§3.1) — the authored-text match side is pinned by the §2.3 scenario
- [ ] the §3.1 cull rule drops empty-after-strip items from all three arrays,
      and `extractSections` culls the same way

**Server seam**
- [ ] `sections` is added to api-server's **per-field forwarding** — a
      type-only change compiles and drops the field at runtime
- [ ] non-empty `sections` without `testFilePath` → 400
- [ ] malformed `sections` (wrong types, `steps`/`stepLines` arity skew) → 400,
      *not* a silent drop
- [ ] every server-side sections test POSTs through the real HTTP entry, never
      constructing a `StepRequest` directly
- [ ] all four gates use `hasSections()` (§3.2), never bare truthiness on `{}`
- [ ] the expander strips a leading `[no-hooks]` from each body step it
      inlines; CLI and server produce identical execution text

**Fixtures**
- [ ] the package's tests assert against `fixtures/sections/`, resolved per §6
- [ ] every fixture touched still has ≥ 2 named consumers
