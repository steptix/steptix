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

Committing works like it always has: once the token opens a call
(keyword + separator), any deviation from the grammar throws with a
caret — `[skill ]` errors with "name missing" exactly as `[skill: ]`
does.

## What moves in lockstep

The grammar lives in one tokenizer, but four other places key off the
token's shape. Each one moved with it — a mirror that drifts here means
F12 navigating a line the runner treats as prose, or an errand refusing a
step the server would happily run:

1. **The tokenizer** — `parseInvocation`
   (src/parser/invocation-parser.ts). The `prefix: '[skill:'` option
   became `kind: 'skill'`; the finder is `/\[<kind>(?=[ \t:])/` and the
   scanner then consumes `WS? ':'? WS?` before the name.
2. **The MCP code-step scan** — `CODE_STEP_PATTERN`
   (src/mcp/assemble.ts), which flags invocation tokens in `run_steps`
   prose warnings and refuses them in `run_errand` and project-less
   runs. Now `/\[(?:skill|tool)(?=[ \t:])/i` — still a strict superset
   of the tokenizer's match set, which the session-manager's
   no-tools-project-less guarantee relies on.
3. **Code-behind's never-generate rule** — `BRACKET_CALL_STEP`
   (src/codebehind/live-compile.ts): a call step is expanded or
   dispatched, never generated from, under either spelling.
4. **TestBench's line matcher** — `parseInvocationLine`, which backs F12
   / Ctrl+Click targets and the step-into tool-line detection. It moved
   from definition-provider.ts into invocation-target-core.ts (the
   vscode-free mirror file) so `node --test` parity rows can pin it
   against the tokenizer's own test table, and the two hand-rolled
   `\[tool:` regexes in commands/index.ts now call it instead of
   carrying private copies.

Line *classifiers* that key on the bracket alone needed nothing:
runner-core's section index and the section-name validator treat any
step opening with `[` as a directive, which covers both spellings by
construction.

## The accepted trade

Prose that literally contains `[skill <word>]` or `[tool <word>]`
mid-step used to flow to the AI as text; now it parses as an invocation
(or throws, if what follows is not grammar). That is the same trade the
original tokenizer story made for `[skill: dismiss the modal]` — a hard
rule beats a silent guess — extended to the colon-less spelling. The
guard is the separator rule above: only the exact keyword followed by
`:` or whitespace commits.

## Tests

- tests/skill-call-parser.test.ts — "optional colon" block: equivalence
  with the colon form, whitespace/`: ` variants, full arg shapes,
  bracketed-prose non-matches, near-miss scanning, `[skill ]` erroring.
- tests/tool-call-parser.test.ts — the same parity for tools.
- tests/mcp-errands-seam.test.ts — colon-less steps refused by
  `run_errand`; `[skills]` prose not swept in.
- tests/codebehind-live-compile.test.ts — colon-less rows in the
  never-generate table.
- testbench-native/tests/invocation-target-core.test.js —
  `parseInvocationLine` parity rows: both spellings, name ranges,
  prose non-matches, near-miss scan.
