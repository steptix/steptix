# `{{parameter}}` completion

## What we're building

Typing `{{` in a test step completes the *runtime* variable names — the ones
filled in per step while a run executes, as opposed to the parse-time
`${...}` namespaces that already complete (see
[env-data-completion.md](env-data-completion.md)):

```
## Parameters
- username: demo@securebank.com
- password: $SB_PASSWORD

## Steps
1. Sign in as {{username}} with {{password}}
2. Capture the account balance [store as: balance]
3. Verify {{│
           ├─ username   demo@securebank.com
           ├─ password   ********
           └─ balance    [as:] on line 9
```

Parameters preview the value they would resolve to (masked under the same
secret rule the reports use); captured names show where the capture happens,
since their values only exist mid-run.

## What completes, and from where

Two sources, in this order:

1. **Declared parameters** — the `- name: value` bullets of the file's
   `## Parameters` section, via runner-core's `parseParameters`
   (runner-core/src/test-meta.ts). Works identically in skills (their own
   `## Parameters`). Preview: the declared value with `$VAR` leaves resolved
   through runner-core `resolveValueFromEnv` against the composed
   project-root env (`.env` + `.env.<envName>` — reuse the existing
   `composedEnv` cached reads in env-data-completion.ts). With no env
   selected the overlay simply doesn't exist; the base `.env` still
   resolves what it can and an unset `$VAR` previews as its literal.
   Masked via the existing runtime secret rule
   (`SECRET_NAME_RE = /password|secret|token|key/i` in
   env-data-completion-core.ts) on the parameter name.

2. **Captures from EARLIER steps only** — names written by step lines
   strictly above the cursor's line, inside the `## Steps` span. At run
   time steps execute in order, so a `{{x}}` before its capture would be
   unresolved; completion must model that. Four marker forms, all `\w+`
   names:
   - `[input: x]` — runtime prompt answers
     (`/\[input:\s*(\w+)\]/i`, variables-panel.js:36)
   - `[output: x]` — DOM captures (`/\[output:\s*(\w+)\]/i`)
   - `[as: x]` / `[store as: x]` — inline captures
     (`/\[(?:store\s+)?as:\s*(\w+)\]/gi`; cf. STORE_AS_RE in
     src/skills/expander.ts:16)
   - `out.k="alias"` on `[skill:]`/`[tool:]` invocations — the **quoted
     alias** enters the caller's scope
     (`/\bout\.\w+\s*=\s*"([^"]+)"/g`, variables-panel.js:43). Offer the
     alias only when it is `\w+`-shaped — `{{...}}` cannot express other
     names (runtime grammar below).
   `[input:]` and `[output:]` are matched **anchored** to the start of the
   instruction (the text after `N. `), because that is the only place the
   runner honours them (`INPUT_STEP_PATTERN` / `OUTPUT_STEP_PATTERN`,
   src/runner/test-runner.ts:43,49). `[store as:]` and `out.k="alias"` are
   matched anywhere.

   Also in scope, ahead of every step: `## Hooks` entries whose scope is
   `before` or `beforeEach` (`- before: … [store as: x]`). They run before
   step 1 wherever they are authored. `after` / `afterEach` run later and
   are never in scope for a step.

   That is the full statically-knowable set. **Prose storage is deliberately
   excluded**: `... and store it as {{x}}` is read by the runtime only in
   `isExtractionStep` (src/runner/step-executor.ts:296-306), which selects a
   richer DOM snapshot and binds nothing — the name comes from the AI's
   `read`/`count` action, and the model is told to use a supplied name only
   when the step carries `[store as: name]`, deriving its own snake_case
   name otherwise (src/ai/prompts.ts:195). Offering a prose name would
   promise a binding the run does not make. A variable the AI invents from
   loose prose ("note the order number for later") likewise has no name
   until the run happens. Authors who want a capture to complete downstream
   write `[store as: name]`.

   Detail text: the marker form and 1-based line, e.g. `[store as:] on
   line 9`. No value preview — there is none at authoring time.

**Not offered:** data-driven row columns (they exist only when the run picks
a row) and anything from later steps. Dedup: first occurrence wins; a name
that is both a parameter and a capture lists once, as the parameter.

## Grammar and context rules

- Runtime reference grammar: `/\{\{(\w+)\}\}/` (src/parser/parameters.ts:102)
  — names are `\w+`, unresolved placeholders pass through with a warning.
  Offered labels must therefore be `\w+`-shaped; parameter names from
  `parseParameters` already are (`[A-Za-z_][A-Za-z0-9_]*`).
- Cursor context: line-local, like `refContextAt` — the nearest `{{` before
  the cursor with no `}` between it and the cursor opens a param context;
  the partial is what follows it (must match `/^\w*$/`, else no context).
  `${{` note: the `${`-parse rejects `${{` (`{` is not a namespace
  character), so the `{{` at offset+1 wins — which matches the runtime,
  where `${{name}}` contains a resolvable `{{name}}`.
- Where: same file gates as the `${...}` provider — markdown, `isTestFile`,
  and nothing inside frontmatter (`{{}}` never interpolates there, for
  tests or skills). **No env gate**: `{{}}` resolution does not require a
  selected env, so the param branch runs before (independent of) the
  `envName` early-return the `${...}` path has.
- Insert plain names; `commitCharacters: ['}']`. No chaining — the
  namespace is flat.
- Trigger: `{` is already a registered trigger character; the second `{` of
  `{{` fires the provider. No registration change needed.

## Shape (the build contract)

Core additions — `env-data-completion-core.ts` (pure, node --test):

```ts
/** {{ cursor context: nearest `{{` before the cursor, no `}` between. */
export function paramContextAt(
  line: string,
  character: number,
): { partial: string; replaceStart: number } | null;

export interface CaptureName {
  name: string;
  marker: 'input' | 'output' | 'as' | 'out-alias';
  /** 1-based line of the capturing step. */
  line: number;
}

/** The runtime variables in scope at 0-based `lineIdx`, in EXECUTION order,
 *  deduped by name. Scope ≠ "written above": pre-hooks lead wherever they
 *  are authored; a `### Name` body executes where it is CALLED, so the main
 *  flow is walked in order with each call splicing its callee's body in
 *  (transitively, cycle-guarded); inside a body, that body's earlier steps
 *  plus whatever ran before its earliest call site. Fenced lines excluded —
 *  `classifyLines` does not track fences. Pass `classified` to reuse one
 *  classification per request. */
export function captureNamesBefore(
  text: string,
  lineIdx: number,
  classified?: ReturnType<typeof classifyLines>,
): CaptureName[];

/** Parameters (declared order, $VAR-resolved values masked by name) first,
 *  then captures (detail: "[<marker>:] on line N"), deduped by name.
 *  New PlainCompletion kinds: 'parameter' and 'capture'. */
export function paramCompletions(
  params: Record<string, string>,
  captures: CaptureName[],
): PlainCompletion[];
```

Wiring — `env-data-completion.ts`:

- In `provideCompletionItems`, when `refContextAt` returns null, try
  `paramContextAt` before giving up. On a param context: run the shared
  gates (`isTestFile`, frontmatter → nothing), then build params via
  runner-core `parseParameters(text)` + `resolveValueFromEnv` against
  `composedEnv(baseEnvPath, overlayPath)` — where `overlayPath` is only
  meaningful when an env is selected; with none, compose the base alone.
  Then `paramCompletions(params, captureNamesBefore(text, position.line))`.
- Item mapping: `parameter` → `CompletionItemKind.Variable`, `capture` →
  `CompletionItemKind.Reference`; range/commit chars per the existing
  `toItem`.

## Tests

Unit (`tests/env-data-completion.test.js`, same file):
- `paramContextAt`: `{{`, `{{us`, mid-line after a closed `{{x}}`, not after
  `}}`, not with no `{{`, `${{` yields a param context, non-`\w` partial
  yields null.
- `captureNamesBefore`: all four marker forms plus pre-hook entries; the
  negatives that must not appear (prose storage, a mid-instruction
  `[input:]`/`[output:]`, an `after` hook, markers in prose/frontmatter, a
  capture on the cursor's own line or below, a non-`\w+` out-alias, a step
  inside a fenced example); execution order over line order (a called
  section's body is in scope at the call site though defined below; an
  uncalled section contributes nothing; inside a body, its earlier steps
  plus what ran before its earliest call site); dedup.
- `paramCompletions`: order (params then captures), `$VAR`-resolved masked
  previews (a `password: $SB_PASSWORD` parameter previews `********`, and a
  `MACHINE_KEY` name masks under the bare-key rule), capture detail text,
  dedup of a name that is both.

Integration (`tests/integration/suite/env-data-completion.test.cjs`, same
suite; extend the dc-project fixture with a `## Parameters` section and
capture markers):
- `{{` offers parameter names with resolved previews and the earlier-step
  capture, not a later-step one.
- The secret-named parameter's preview is `********` and the raw value
  appears nowhere.
- Works with NO env selected (parameters still offered — the `${` path's
  emptiness with no env must not leak into `{{`).

## Build notes

- Bump `steptix-vscode/package.json` 0.5.91 → 0.5.92 (CLAUDE.md rule).
- Update env-data-completion.md's "What we're building" cross-reference
  (one line noting `{{}}` completion now exists and pointing here).
- Everything stays silent/best-effort; no toasts; keystroke-shaped (the
  param branch adds no file reads beyond the already-cached env files).
