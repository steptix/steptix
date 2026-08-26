# Skill-name completion inside `[skill ...`

## What we're building

Today skill completion fires in one place: right after a step ordinal,
where the dropdown offers whole-call snippets (`[skill: login]`) next to
the file's inline sections. The moment an author types the token
themselves — `1. [skill ` or `1. Log in [skill: ` — completion goes
silent, and accepting a snippet item at `1. [sk` pastes a second copy of
the prefix (`1. [[skill: foo]`).

After this story, an open `[skill` token completes the *name*, in place:

```
## Steps
1. [skill │
          ├─ auth/login
          ├─ auth/reset_password
          └─ capture_url
2. Log in [skill: au│      → filters to the auth/ names, replaces `au`
3. [skill auth/│           → subfolder names keep completing after `/`
```

The names come from the same recursive `skillsDir` walk the snippet path
already uses (`collectSkillNames`), so subfolder skills appear
path-qualified and every offered spelling parses. Accepting inserts just
the name — the author continues with args or `]` — and both separator
spellings work, since the colon is optional in the invocation grammar
([stories/optional-invocation-colon.md](../../../stories/optional-invocation-colon.md)).

The step-start snippet path stays, and gets the fix its wart deserved:
its `[skill: name]` items now carry an explicit replace range covering
the typed token, so accepting at `1. [sk` *replaces* `[sk` instead of
appending after it.

## Where it fires, exactly

A dropdown position is "inside an open `[skill` token" when the text
before the cursor ends with the keyword, a separator, and a partial name
that is still a valid name prefix:

```
new RegExp(String.raw`\[skill${SEP}(${NAME}*)$`)
```

where `SEP` and `NAME` are the shared separator and name-class fragments
in `invocation-target-core.ts` — the same two the file's
`INVOCATION_RE` is built from, so the completion anchor and the
Go-to-Definition matcher cannot disagree about where a name begins.

- `1. [skill │`, `1. [skill: │`, `1. [skill:│`, `1. [skill : │` — all
  separator spellings, empty partial.
- `1. Log in [skill au│` — labels before the token are fine; the regex
  is anchored to the cursor, not the line start.
- `1. [skill: login] then [skill │` — a *closed* call earlier on the
  line doesn't confuse it; only the trailing open token matches.
- `1. [skill: login]│` — no match (the `]` closed the call); nothing is
  offered mid-prose after a complete call.
- `see [skillful] anim│` — no separator after the keyword, no match:
  bracketed prose stays quiet, same rule as the tokenizer.

Once a name char that the grammar can't lex appears (a `.`, a space —
i.e. the author moved on to args), the anchor breaks and the provider
returns nothing; argument positions are not this story's business.

Both completion paths stay gated on `isTestFile` + `inStepRegion` — a
skill file has its own `## Steps`, so nested `[skill` calls complete
inside skill bodies too.

## Mechanics

- The anchor test lives in `invocation-target-core.ts`
  (`openSkillNamePrefix`), vscode-free next to `parseInvocationLine` and
  `collectSkillNames`, with `node --test` rows pinning the shapes above.
- `SectionCompletionProvider` checks it *first*: inside an open token
  the author has committed to a skill call, so section names and
  whole-call snippets are not offered there — only names, each with
  `range` = the typed partial, so acceptance replaces in place.
- Items are `CompletionItemKind.Reference` with detail `skill`, matching
  the snippet path's look.
- Trigger characters gain `'['`, `':'` and `'/'` alongside the existing
  `' '`: `1. [` pops the snippet list, the separator pops the name list
  without a manual Ctrl+Space, and `/` re-opens it mid-path
  (`[skill: auth/│`) if the author dismissed it.

## Tests

- `tests/invocation-target-core.test.js` — anchor rows: every separator
  spelling, label prefixes, closed-call lines, bracketed prose,
  partial/`replaceStart` offsets.
- `tests/integration/suite/skill-name-completion.test.cjs` — a
  runtime-generated project (`snc-project/`, own `aiui.config.json`,
  `skills/` with a flat and a subfolder skill) driven through
  `vscode.executeCompletionItemProvider`: names offered at an open
  token (flat + path-qualified), replace range covering the typed
  partial, nothing offered after a closed call or inside bracketed
  prose, and the step-start snippet path's new explicit range.
