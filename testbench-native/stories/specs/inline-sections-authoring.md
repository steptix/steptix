# Inline sections: authoring affordances (navigation, completion, diagnostics)

Companion to [stories/test-script-sections.md](../../../stories/test-script-sections.md)
(grammar and semantics — including the raw-text match rule this spec's
index must mirror exactly) and
[inline-sections-runtime.md](inline-sections-runtime.md) (execution + debug
parity). This spec is the third, thinnest slice: the editor affordances
that make bare-name invocation safe in practice.

## 1. Why this slice exists

The language story deliberately chose bare-name invocation — a step is a
section call iff its raw text matches a defined section name. The failure
mode is silent: a typo ("Logn") or a stale call site after a rename isn't
an error, it's a plausible AI instruction. The parser-side mitigations
(dead-section warning, report badge) fire at run/parse time; this spec adds
the *while-typing* layer in testbench-native:

1. A resolved call **looks different** (document link) — if the underline
   is missing, it isn't a call.
2. An unresolved-but-close name and an orphaned section are **squiggled**.
3. Section names **complete** after a step number.
4. **Go to definition** jumps between call sites and `### Name` headings.

testbench-monaco gets none of this (it has no provider surface at all — no
DefinitionProvider is registered there today, and the runtime spec already
makes it refuse sectioned files).

## 2. Current provider surface

The only language-feature provider in testbench-native is the
`InvocationDefinitionProvider`
([src/extension/definition-provider.ts](../../src/extension/definition-provider.ts)),
registered for `markdown` in
[src/extension/extension.ts](../../src/extension/extension.ts). It matches
`INVOCATION_RE = /\[(skill|tool):\s*([A-Za-z0-9_-]+)/`, resolves skills to
`<skillsDir>/<name>.md`, and has a `findLine`-style helper for locating a
heading/bullet inside a target file — directly reusable for same-file
`###` targets. There are no completion, hover, code-lens, folding, or
diagnostic providers (folding/outline for `###` headings come free from
VS Code's built-in markdown support — neither extension contributes a
custom language for `.md`).

## 3. Design

All features share one cheap pure function (new, beside the existing
parsing helpers in the host copy of `step-lines.ts`). Its shape is sized
by its consumers — links need character ranges, the empty-body diagnostic
needs step counts, and the near-miss diagnostic needs the *non*-calls:

```ts
interface SectionIndex {
  /** keyed by lowercased raw name */
  sections: Map<string, {
    name: string;
    headingLine: number;
    /** body size — feeds the "invoked section has no steps" diagnostic */
    stepCount: number;
  }>;
  /**
   * Every step line whose match text resolves to a section — main-flow
   * AND section-body lines (sections may invoke sibling sections, and
   * those call sites deserve the same links/navigation/liveness
   * accounting as main-flow ones). `nameStart` is the 0-based column
   * where the match text begins (past the `N. ` prefix and any
   * `[no-hooks] ` marker) — the DocumentLink/definition range is
   * [nameStart, nameStart + matched text length).
   */
  calls: { line: number; name: string; nameStart: number }[];
  /**
   * Plain-text steps that resolved to nothing (bracket-token lines
   * excluded entirely) — the near-miss diagnostic's input.
   */
  nonCallSteps: { line: number; matchText: string; nameStart: number }[];
  /**
   * Headings whose (case-insensitive) name lost to an earlier definition
   * — the duplicate diagnostic needs a range per *losing* heading, and
   * the Map above collapses them by construction. Empty-name headings
   * (bare `###` lines, surfaced by the runtime spec's §3 hashes-only
   * classification rule) land here too, under name "".
   */
  duplicates: { name: string; headingLine: number }[];
}
function buildSectionIndex(text: string): SectionIndex;
```

built on `extractSections` / `classifyLines` from the runtime spec, and
using the language story's **single match-text derivation** (strip a
leading `[no-hooks]`, trim, casefold — applied to the number-stripped raw
line; no markdown-formatting normalization), so the grammar and the match
rule each have exactly one specification. The index is recomputed on
demand (documents are small; no caching layer in v1).

### 3.1 Definition provider

Extend `InvocationDefinitionProvider`:

- On a step line (`step` or `section-step` kind): first give the existing
  `INVOCATION_RE` path its chance — `[skill:]` / `[tool:]` lines are never
  section calls, mirroring the expander's resolution order. Then, if the
  line is in `calls` → return the `### Name` heading position.
- On a **`### Name` heading** → return all call-site positions (VS Code
  renders multiple definitions as a peek list, giving "find usages" for
  free in v1).

### 3.2 Document links

A `DocumentLinkProvider` underlines the section-name text of every entry
in `calls` (main-flow and body lines alike), targeting the heading. This
is the anti-footgun: authors learn that a call renders as a link, so a
step they *meant* as a call that stays plain is instantly visible. (The
raw-text rule makes this trustworthy: the index matches iff the expander
matches — `1. **Login**` gets no link *and* is no call.)

### 3.3 Completion

A `CompletionItemProvider` (trigger: typing after `^\s*\d+\.\s`) offers the
file's section names (kind `Function`, detail "inline section", sorted
first) plus — since we're there — `[skill: ` snippet items for files in
`skillsDir` (a cheap `readdir` of `skillsDir`; nothing existing enumerates
it today, so skip this if it grows the slice — it's a bonus, not a
requirement).

### 3.4 Diagnostics

A `DiagnosticCollection` (`testbench-sections`), refreshed on open/change
(debounced with the same cadence decorations use):

| Condition | Severity | Message |
|---|---|---|
| Section with zero call sites anywhere in the file | Information | `Section "X" is never used` |
| Duplicate section name (case-insensitive) | Error | mirrors the parse error (and the run refusal in runtime §4.5) |
| Reserved / `[`-prefixed / `{{`-containing section name | Error | mirrors the parse error |
| Empty section name (bare `###` line in the Steps span) | Error | mirrors the parse error; anchored to the bare-hash line |
| Invoked section has no steps | Error | mirrors the expansion error |
| Step text (any step line, body included) within edit distance 1–2 of exactly one section name, not equal | Warning | `Did you mean section "X"?` |

The near-miss comparison runs over the same match-text derivation as
resolution (so casing/whitespace differences never count as "distance"),
and skips any line claimed by a bracket token (`[skill:]` / `[tool:]` /
`[input:]` / `[interactive]`) — those can never be section calls, so
`1. [skill: login]` must not warn about a section named "Login".

"Zero call sites" uses the same flat rule as the expander's dead-section
warning: any resolved call site anywhere in the file counts — including
one inside another (even dead) section — and hook entries never count. So
the diagnostic and the runtime warning can never disagree about liveness.

The near-miss row is the only heuristic; it's conservative (unique
near-match only) and a Warning, not an Error. All other rows restate
parse/expansion errors so authors see them before running. (Bare `###`
lines are visible to the index only via the runtime spec's §3 hashes-only
classification rule — `ANY_HEADING_RE` alone cannot see them; that rule
is what makes the empty-name row anchorable.)

### 3.5 Template

`templates/init/tests/sections-demo.md` (added by the language story's docs
task) doubles as the manual QA file for all of the above.

## 4. Testing

- **Unit (`buildSectionIndex`):** names/casing/heading lines; call-site
  detection on main-flow *and* body lines; the shared match-table fixture
  (`fixtures/sections/match-table.json`, per runtime §9) is consumed here
  too — bold/backtick/trailing-period rows must produce no call sites,
  byte-equal formatted pairs must — so the index cannot drift from the
  execution-side matchers.
- **Unit (diagnostics):** each table row; "never used" honours body-line
  call sites (a section invoked only from another section is *not*
  flagged) and ignores hook entries; the near-miss single-candidate rule
  and its non-firing on multiple candidates.
- **Integration (electron harness):** go-to-definition from a main-flow
  call → heading, from a body-line call → heading, and heading → all
  calls; document links present on resolved calls (both kinds) and absent
  on near-misses; completion lists section names after `1. `.

## 5. Out of scope

- Rename refactoring (rename heading ⇒ rewrite call sites) — natural
  follow-on, needs a WorkspaceEdit provider; the near-miss diagnostic
  covers the drift risk meanwhile.
- "Extract selection to section" / "Promote section to skill" code actions
  — tracked in the language story's open questions.
- Hover previews of section bodies; folding/outline (already provided by
  built-in markdown).
- A `[store as:]` row model for the Variables panel (see runtime §3 — the
  panel's row sources are unchanged).
- Any Monaco work.
