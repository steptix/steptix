# Optional colon in `[skill ...]` / `[tool ...]` calls

## What we're building

Today an invocation only counts when the keyword carries a colon —
`[skill: login]`, `[tool: seed_cart]`. After this story the colon is
optional; the same calls read:

```markdown
1. [skill login]
2. [skill auth/login username role="admin" out.session_id]
3. Log in as admin [skill login role="admin"]      # labels still work
4. [tool seed_cart items=2]
```

Every arg form, output alias, path-qualified name, label, and trailing
comment behaves identically under both spellings — the colon becomes pure
style. `[skill: login]` remains the canonical form (docs, completion
inserts, prompts that teach the syntax to agents).

## The separator rule

`[<kind>` opens an invocation only when followed by `:` or inline
whitespace:

```
Sep := WS? ':' WS?  |  WS
```

So all of `[skill: x]`, `[skill:x]`, `[skill x]`, `[skill  x]`, and
`[skill : x]` are the same call — while bracketed prose that merely
contains the keyword's letters (`[skills]`, `[skillful]`, `[toolbox]`, a
bare `[skill]`) has no separator and stays prose. The finder also scans
past near-misses: in `see [skillful] then [skill login]` the first
`[skill` sits inside a longer word and the real token is still found.

## Committing differs by spelling — on purpose

`[skill:` commits: once that token opens a call, any deviation from the
grammar throws with a caret. That is the original tokenizer's whole
point (stories/skill-call-syntax.md) — a malformed call the author
clearly meant should not silently become an AI prose step.

The colon-less spelling cannot carry that rule, because ordinary English
produces it. `Verify the [skill level: expert] badge` and
`Click the [skill (beta)] badge` are prose, and `extractSteps` throws at
PARSE time — so committing to them fails the **entire test file**, not
the step. One sentence would take down the suite.

So: a colon-less token that does not parse is **not a call**. It returns
`null` and flows through as prose. The cost is that a typo'd colon-less
call (`[skill login pass=]`) reaches the AI instead of erroring; authors
who want the strict reading write the colon.

Markdown links are declined in **both** spellings. `[skill guide](./g.md)`
otherwise parses as a call to a skill named `guide` and fails the file
when no such skill exists — and a link is the likeliest way a bracketed
keyword appears in a markdown-authored suite. Only an immediately
adjacent `(` counts, so `[skill: login] (smoke only)` still parses.

## What moves in lockstep

The grammar lives in one tokenizer, but four other places key off the
token's shape. Each one moved with it — a mirror that drifts here means
F12 navigating a line the runner treats as prose, or an errand refusing a
step the server would happily run:

1. **The tokenizer** — `parseInvocation`
   (src/parser/invocation-parser.ts). The `prefix: '[skill:'` option
   became `kind: 'skill'`; the finder is `/\[<kind>(?=[ \t:])/` and the
   scanner then consumes `WS? ':'? WS?` before the name.
2. **The MCP code-step scan** — `isCodeStep` (re-exported by
   src/mcp/assemble.ts), which refuses invocation steps in `run_errand`
   and project-less runs. It does not imitate the tokenizer, it **calls**
   it — so the property the session-manager's no-tools-project-less
   guarantee relies on holds by construction rather than by comment.
3. **Code-behind's never-generate rule**
   (src/codebehind/live-compile.ts): the same `isCodeStep` predicate.
4. **Steptix's line matcher** — `parseInvocationLine`, which backs F12
   / Ctrl+Click targets, the step-into tool-line detection, and
   `rootFrameSteps`' skill filter. It moved from definition-provider.ts
   into invocation-target-core.ts (the vscode-free mirror file) so
   `node --test` parity rows can pin it, and the three hand-rolled
   regexes in commands/index.ts now call it instead of carrying private
   copies. steptix-vscode is a separate package and genuinely cannot
   import the parser; everything in `src/` can, and now does.

**Why the two in-package mirrors became calls rather than regexes.** They
were look-alike patterns, and they had already drifted in both
directions: an `/i` the case-sensitive scanner does not have (so
`Verify the button reads [Tool Settings]` was refused by `run_errand` as
a code step while the runner ran it as prose), and a `\s` plus a `^`
anchor (so a non-breaking space opened a call the scanner calls prose,
while every *labelled* call — a documented feature — escaped the
never-generate rule and got AI-generated code written for a step that is
always dispatched to its tool). Beyond that, no regex can stay honest
now: the link and colon-less-leniency decisions above live inside the
parser. `tests/invocation-mirror-parity.test.ts` asserts the equivalence
directly — the test whose absence let them drift.

Line *classifiers* that key on the bracket alone needed nothing:
runner-core's section index and the section-name validator treat any
step opening with `[` as a directive, which covers both spellings by
construction.

## The accepted trade

Prose that contains a well-formed `[skill <word>]` or `[tool <word>]`
mid-step used to flow to the AI as text; now it parses as an invocation.
`Open the [tool bar] and pick Save` calls a tool named `bar`.

That is the residue of the feature, and it is bounded by three rules
above: the separator (so `[skills]`, `[skillful]`, `[skill]` are prose),
the link guard (so `[tool docs](url)` is prose), and colon-less leniency
(so anything that does not *parse* is prose rather than an error). What
remains is the case where the bracketed prose happens to be a valid call
— rare, and visible in the editor, since a resolved call renders as a
link and an unresolved name gets a squiggle.

An earlier draft of this change had no link guard and no leniency, and
committed on any colon-less token. Both `Click the [skill guide](./g.md)`
and `Verify the [skill level: expert] badge` then failed the entire test
file at parse time. Worth recording as the reason those two rules exist.

## Tests

- tests/skill-call-parser.test.ts — "optional colon" block: equivalence
  with the colon form, whitespace/`: ` variants, full arg shapes,
  bracketed-prose non-matches, near-miss scanning, `[skill ]` and other
  unparseable colon-less tokens degrading to prose (and `[skill: ]` still
  throwing), markdown links declined, and a declined candidate not
  swallowing a real call later on the same line.
- tests/tool-call-parser.test.ts — the same parity for tools.
- tests/mcp-errands-seam.test.ts — colon-less steps refused by
  `run_errand`; `[skills]` prose not swept in.
- tests/codebehind-live-compile.test.ts — colon-less rows in the
  never-generate table.
- steptix-vscode/tests/invocation-target-core.test.js —
  `parseInvocationLine` parity rows: both spellings, name ranges,
  prose non-matches, near-miss scan.
