# Parameter completion inside a skill call

## What we're building

[skill-name-completion.md](skill-name-completion.md) completes the NAME.
This story completes what comes after it: with the cursor in the argument
position of an open skill call, the dropdown lists the skill's declared
parameters — read from its own `## Parameters` section — and accepting one
inserts `name="│"` with the caret between the quotes:

```
skills/login.md:
  ## Parameters
  - username: the account to sign in as
  - password: $SB_PASSWORD
  ## Outputs
  - session_id: the logged-in session identifier

## Steps
1. [skill login │
               ├─ username      the account to sign in as
               ├─ password      $SB_PASSWORD
               └─ out.session_id
```

Accepting `username` yields `[skill login username="│"` — type the value,
Tab jumps past the closing quote. Typing a space re-opens the list (space
is already a trigger character), now minus `username`: parameters already
present in the call — on either side of the cursor — drop out, so the
list is always "what's left to pass". Outputs are offered after the
parameters as `out.<name>` items, inserted bare (the shorthand that
exposes the output under its own name; add `="alias"` by hand to rename).

Inside the quotes the existing completions take over: `{{` offers runtime
variables ([param-completion.md](param-completion.md)) and `${` the
env/data namespaces — so the full chain
`username="{{username}}"` composes out of three completions and zero
hand-typed names.

## Where it fires, exactly

The argument position of an OPEN skill call: after the keyword, separator
(colon optional), a complete name, and at least one space — with the
cursor not inside a quoted string, an array literal, or a bare value, and
the call's `]` not yet typed (or the cursor sitting before it: editing
`[skill login │ role="admin"]` works, and `role` is correctly excluded as
used).

That sentence is a tokenizer, not a regex. Argument text can contain
whitespace, `]`, and `[` inside quoted values (`msg="a ] b"`) and array
literals (`ids=[1, 2]`), so knowing "am I at an arg position" means
walking the call the way the runner's scanner does: skip inline space,
identifier, optional `=` + (quoted string | `[...]` with quote-aware
depth | bare literal), repeat. `openSkillArgsContext(line, cursor)` in
`invocation-target-core.ts` is that walk — vscode-free, `node --test`ed,
sharing the SEP/NAME fragments with the file's other matchers. It returns
the skill name, the partial arg being typed (empty at a fresh position),
its replace column, and the used parameter / output names from both sides
of the cursor; or `null`, which keeps the surface quiet:

- `1. [skill login│` — still the name (name completion owns it).
- `1. [skill login msg="a │` — inside a quoted value.
- `1. [skill login count=│` — a value is expected, not a name.
- `1. [skill login ids=[1, │` — inside an array literal.
- `1. [skill: login] │` — the call is closed.

## What is offered, and from where

The skill file the name resolves to (`canonicalSkillName` +
`<skillsDir>/<name>.md`), parsed with the same rules the runner uses:

- **Parameters** — runner-core's `parseParameters`, the parser the `{{}}`
  completion already trusts for server parity. The bullet's value (a
  default like `$SB_PASSWORD`, or a description) becomes the item's
  documentation — shown as the literal file text, never resolved through
  the env, so no secret can leak into a dropdown.
- **Outputs** — `- name` or `- name: description` bullets under
  `## Outputs`, mirroring `extractOutputs` (src/parser/markdown.ts),
  which tolerates the bare form parameters don't.

Both lists are filtered to names the invocation grammar can lex as an
argument (`\w+` — `readIdentifier()` with no options admits no hyphen),
the same never-offer-what-cannot-parse rule `collectSkillNames` applies
to file names. Reads go through a small mtime+size cache, since the walk
runs per keystroke while typing inside the call.

Parameters insert as the snippet `name="$1"$0` — caret between the
quotes, Tab lands after them. Outputs insert bare. Missing skill file,
no `## Parameters`, or a tool call: no items, no error.

## Tests

- `tests/invocation-target-core.test.js` — the walker matrix: every
  quiet case above, partial/`replaceStart` offsets, used-arg collection
  across both sides of the cursor, quoted `]`/`[` and array literals,
  a closed call followed by a second open one, `out.` partials; and
  `parseSkillIo` rows pinned against `parseParameters`' and
  `extractOutputs`' own shapes.
- `tests/integration/suite/skill-arg-completion.test.cjs` — a
  runtime-generated `sac-project/` driven through
  `executeCompletionItemProvider`: the parameter list with snippet text
  and replace range, used-parameter filtering, `out.` items, and the
  quiet-inside-quotes case.

## Not this story

Tool arguments. A tool's parameters live in its TypeScript schema, not a
markdown section — offering them means loading (or statically reading)
the tool file, a different mechanism deserving its own story.
