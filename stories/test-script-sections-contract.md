# Inline sections: the frozen cross-package contract

**Status: frozen.** This document is the single source for the shapes and
rules that more than one package implements. Change it only by editing this
file first and re-reviewing — never by editing an implementation until it
passes, and never by editing a fixture row to make a test go green.

Companions: [test-script-sections.md](test-script-sections.md) (grammar and
semantics — the *why* for everything below),
[inline-sections-runtime.md](../steptix-vscode/stories/specs/inline-sections-runtime.md),
[inline-sections-authoring.md](../steptix-vscode/stories/specs/inline-sections-authoring.md).

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

But `rawSteps` only exists on the CLI parse path: what the server *receives*
is already in raw/instruction form, so there is no second array to send. So the
rule is stated once, for every step list, at every level:

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

**But the fallback is only as good as the `steps` it falls back to,** and the
caller owes it authored text. "Received in raw form" is a fact about the request
and stops being one the moment the server rewrites `steps` itself: a looped
`### Section` interpolates the iteration's row into the body's steps *before* it
recurses, so `steps[i]` there reads `Upload a.png` where the author wrote
`Upload {{file}}`. So the recursion **sets** the body context's `rawSteps` from
the section definition's own lines (`section.rawSteps ?? section.steps`) instead
of letting the fallback answer. Leaving it to the fallback was measured twice
over: the server bound one code-behind entry per row where the CLI binds one
(stories/data-driven-rows.md), and a skip reason built from the match side
quoted a secret row value on four surfaces. The formula above is unchanged —
whoever supplies the list is responsible for its match side being the line as
authored.

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

*Supersedes:* [inline-sections-runtime.md](../steptix-vscode/stories/specs/inline-sections-runtime.md) §9
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
**steptix-vscode's `runStepBlock` pre-flight** refuses the run before a
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
`rawSteps`**. The incoming `steps` are already the raw/instruction form, so
there is nothing a second array would say. Do not add it to the wire.

That still holds for a LOOPED body, where §2.1's fallback does **not** cover the
match side — but the missing piece is server-side, not a field. The server
interpolates each row into the body's steps before recursing, so it sets the
body context's `rawSteps` from *this* array, read before any row went into it.
The authored text was on the wire all along; the fix is to keep hold of it
rather than to send it twice.

`steps` carries `[no-hooks]` markers **verbatim**. The expander strips them
when inlining a body — the CLI parser strips at parse time, so without the
expander-side strip the literal marker text would reach the AI on the server
path only.

**A wrapped list item cannot be represented here, and must be refused.**
Markdown continues a list item across lines and the CLI executes the item's
*whole folded text*, but this shape carries one string per step and every
client-side scanner sees only the item's first physical line:

```markdown
### Checkout
1. Sign in
   using the saved credentials
2. Pay
```

The CLI runs `"Sign in\nusing the saved credentials"`. A client following the
`/^\s*\d+\.\s+/`-then-`trim()` rule above sends `"Sign in"` — which, if a
`### Sign in` exists, the server then resolves as a **call**. That is not a
truncated instruction; it is a different control flow, arrived at silently.

Folding the continuation client-side is not the answer: it would put a fourth
hand-written copy of marked's list semantics in the tree, which is the drift
§1 exists to prevent. So the rule is **detect and refuse**:
`runner-core`'s `findWrappedStepLines(text)` reports every wrapped step, and
the run-time pre-flight refuses a file with a wrapped step **in a section
body** before a request is built.

Wrapped *main-flow* steps have been truncated by `extractSteps` since long
before sections existed; that is a pre-existing defect, tracked as
[issues/036](../issues/036-wrapped-main-flow-steps-truncated-on-the-steptix-path.md),
and not something this feature's gate is required to fix. `findWrappedStepLines`
reports those lines too, so widening the gate later needs no new detection.

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
| key `!== matchText(entry.name)` | **400** — see below |
| `matchText(entry.name) === ''` | **400** — an empty name is refused at parse time by all three implementations (§2.5) and never enters an index, so it can only arrive from a broken client, and would be uncallable |
| `sections: {}` | treated as absent — legacy path, no 400 |
| invoked section with an empty body; cycles | expander errors, not 400s |
| duplicate names | unrepresentable (JSON collapses keys); the client's pre-flight owns this |

**On validating the key.** The server uses incoming keys **verbatim** and
never re-derives them for *use* — but it does check them. A key that isn't
`matchText(name)` passes every type check and then can never be called: every
lookup derives its key from the step text, so it misses, and the bare name
ships to the AI as a literal instruction. That is the silent degradation this
whole block departs from the house drop-and-continue pattern to prevent.

The cost is real and worth stating: the key is produced by a hand-written copy
of `matchText` in the client, so drift in that copy now fails the whole run
with a 400 rather than degrading one section. That is the intended trade —
a loud failure on a contract violation beats a quiet one — but it means the
copies must stay in step, which is what `match-table.json` is for.

**On `__proto__`.** A section may legally be named `__proto__`: §2.5 bans
reserved keywords, a leading `[`, `{{` and the empty string, and nothing else.
Assigning such a key into an object literal invokes the prototype setter — the
entry vanishes *and* the map's prototype is replaced — so **every** map built
from untrusted section names must be `Object.create(null)`, on both sides of
the wire:

| Map | Where |
|---|---|
| `sectionMap` | the CLI parser, `src/parser/markdown.ts` |
| the forwarding copy | `src/server/api-server.ts` |
| the per-invocation rebuild | `applySkillScope`, `src/skills/expander.ts` |
| **the payload builder** | the client, when it turns `extractSections` output into the `sections` record |

The last one is the client's and does not exist yet. Getting it wrong loses
the section *before the request is sent*: `hasSections()` then reports false,
the server never sees it, and the bare name reaches the AI — the same
degradation, one layer up, where none of the server's validation can catch it.
`SectionIndex` (§3.5) is a `Map` and so is safe by construction; the payload
builder is not.

Section lookup additionally uses an own-property check, so a step reading
`constructor` resolves to nothing rather than to
`Object.prototype.constructor` (which aborted the run outright).

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
[inline-sections-authoring.md](../steptix-vscode/stories/specs/inline-sections-authoring.md) §3
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

// runner-core/src/step-lines.ts — 1-based lines of every step (main flow AND
// section body) whose markdown list item wraps onto following lines. Such a
// step is unrepresentable on the wire (§3.2) and a body one must be refused
// by the pre-flight. Whitelist semantics: inaccuracies are false alarms, never
// missed ones.
export function findWrappedStepLines(text: string): number[];

// runner-core/src/step-lines.ts
// What a user's line selection means. `scope` is part of the answer because
// body lines and main-flow lines execute differently (see
// steptix-vscode/stories/specs/sections-run-and-resume.md §4.2).
// Resolution order is fixed: main-flow matches win over body matches, so a
// selection spanning both runs the main flow only and never double-runs a
// body alongside its own invocation.
export type RunScope = 'main-flow' | 'section-body';
export function resolveRunSelection(
  text: string,
  requestedLines: number[],
): { scope: RunScope; lines: number[] };

// runner-core/src/step-lines.ts — body step lines of the section whose span
// contains 1-based `line`, or `[]` when it sits in no section body. The span
// runs heading-to-next-heading, NOT first-body-step-to-last, so a resume
// anchor whose own step was just deleted still resolves to its section.
export function sectionBodyLinesAt(text: string, line: number): number[];

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

`LineKind` gains three members:

```ts
export type LineKind =
  | 'step' | 'section-heading' | 'section-step' | 'inert-step'
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
   3, else `heading`. An in-span depth ≥ 4 heading additionally **opens an
   ignored region** (rule 4a).
4a. **Ignored regions.** Inside the span, a heading of depth ≥ 4 *with text*
   opens an ignored region. Every line until the next `section-heading` (a
   `###` with text, or a hashes-only line at any depth — both open a real
   section) or the end of the span is inert: a numbered item there is
   `inert-step`, never `step` and never `section-step`. A further depth ≥ 4
   heading renews the region. Nothing runs an `inert-step`, in the main flow
   or in any body, and nothing may address one — no breakpoint, no Run Step
   Here, no Compile This Step, no gutter affordance.
5. in-span and `STEP_LINE_RE` → `section-step` if any `section-heading` was
   seen earlier in the span, else `step`
6. otherwise `prose`

Rule 3 is the one that is easy to skip and expensive to omit: `ANY_HEADING_RE`
demands a non-space after the hashes, so a bare `###` is invisible to it. Left
as prose, the CLI throws its empty-name parse error while Steptix happily
runs the "body" items as main-flow steps — the exact CLI/Steptix divergence
this feature exists to eliminate.

**Body attribution.** A hashes-only line at any depth ≥ 3 **both terminates
the preceding body and opens a new empty-name section.** The grammar's
"a body runs until the next heading of depth ≤ 3" applies to `ANY_HEADING_RE`
headings only — which is why a `#### With text` does *not* close a body
(pinned by `classification.md` lines 27→31: `### Cleanup` is still what ends
Login) while a bare `####` does (pinned by `classification-hashes.md`).
Consecutive hashes-only lines therefore yield one empty-name section each,
not one section with a merged body.

Not closing a body is **not** the same as leaving it in one. A `####` with
text does not close the body it sits in, and the numbered items beneath it
still leave it: they are inert (rule 4a). The earlier grammar called such a
heading "inert prose" and then let its items run — absorbed into the main
flow when no section was open, and into whichever body was when one was.
Both were silent. `classification.md` line 29 pins the replacement: it sits
under the depth-4 heading on line 27, it is an `inert-step`, and it is not
one of Login's steps.

Consumer split (runtime spec §3). **No consumer on any rung sees an
`inert-step`** — every one of them dispatches on `step` / `section-step`
positively, so a distinct kind excludes inert items by construction rather
than by each caller remembering to. The editor is the one place that must
still see them, to dim the line and say why it will not run
(`inertRegionHeading` names the heading responsible).

- **main flow only** — `extractSteps`, `resolveRunLines`,
  `nearestStepAtOrBelow|Above`. These are runner-core's API. `resolveRunLines`
  keeps this contract precisely so `runLines([])` cannot grow a body step.
- **main flow, or body — the caller says which** — `resolveRunSelection` and
  `classifySelectedSteps`, whose trailing `scope` argument defaults to
  `'main-flow'` so every existing call site keeps the old contract.
  `resolveRunSelection` is the only function permitted to choose the scope,
  and it chooses `'section-body'` only for a selection that names body lines
  and no main-flow line. See
  [sections-run-and-resume.md](../steptix-vscode/stories/specs/sections-run-and-resume.md).
- **main + body** — `extractStepLineIds`, which exists in **three** files: the
  native host [step-lines.ts](../steptix-vscode/src/extension/step-lines.ts)
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
| `match-table.json` | §2, both derived text and boolean, 19 rows | root parser/expander suite; runner-core (`matchText` + end-to-end through `buildSectionIndex`); native + monaco copy tests (the `[no-hooks]` rows only — the mirrors reimplement the marker strip in their cull path but do no name matching, so the casefolding and Turkish-I rows do not apply to them) |
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
[tests/cache-dir-parity.test.ts](../tests/cache-dir-parity.test.ts) (since removed) ↔
[steptix-vscode/tests/cache-dir-parity.test.js](../steptix-vscode/tests/cache-dir-parity.test.js) (since removed)
precedent:

| Consumer | Path from its own directory |
|---|---|
| root vitest (`tests/`) | `../fixtures/sections/…` |
| `runner-core/tests/` | `../../fixtures/sections/…` |
| `steptix-vscode/tests/` | `../../fixtures/sections/…` |
| `testbench-monaco/tests/` | `../../fixtures/sections/…` |
| `steptix-vscode/tests/integration/suite/` | `../../../../fixtures/sections/…` |

### Three notes on the fixture location

1. **Deliberate deviation from precedent.** The existing cross-package parity
   fixture lives under `tests/fixtures/`, but `tests/` is the root package's
   vitest root — resolvable from the other three packages only by reaching
   across. `fixtures/` is already the package-neutral home, and the runtime
   spec §9 names `fixtures/sections/match-table.json` explicitly. Keeping it
   here is intentional; don't "fix" it back.
2. **These files are visible to Steptix.** Discovery globs `**/*.md`
   ([test-discovery.ts](../steptix-vscode/src/extension/test-discovery.ts),
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
- [ ] a selection spanning main flow and a body resolves to `'main-flow'`
      (never runs a body inline alongside its own invocation)
- [ ] `startAt` into a test-file body line is accompanied by a `steps` list
      that **begins at that body's invocation** — an anchor sent with a
      narrower range can match a different invocation of the same section

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
