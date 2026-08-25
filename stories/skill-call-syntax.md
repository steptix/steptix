# Skill call syntax: shorthand parameters and precise error reporting

## Context

`[skill: name ...]` invocations are parsed by a single regex in
[src/skills/expander.ts](../src/skills/expander.ts):

```ts
const SKILL_INVOCATION_RE = /^\s*\[skill:\s*([\w-]+)((?:\s+[\w.]+="[^"]*")*)\s*\](.*)$/;
```

Two pain points have surfaced from real use:

1. **Silent malformed calls.** If an author writes a malformed call, the regex
   simply fails to match, and the line is treated as a plain natural-language
   step that gets sent to the LLM as-is. The most common failure mode is an
   unclosed double-quote — e.g. `[skill: login password="{{password}}]` (the
   trailing `"` is missing). The runner cheerfully forwards the literal text to
   the AI, which then produces nonsense actions or hallucinates around the
   broken instruction. The author gets no diagnostic.

2. **Verbose pass-through.** The overwhelmingly common case is to forward a
   caller-scope variable to a skill parameter of the same name. Today this
   requires repeating the name three times:

   ```markdown
   [skill: login username="{{username}}" password="{{password}}"]
   ```

   For a skill with three or four parameters, a single invocation becomes a
   long line, and authors instinctively reach for line wrapping or end up
   making the skill take fewer parameters than it should.

This doc proposes a small, focused parser refresh that fixes both at once.

## Goals

1. Detect malformed skill calls at parse time and report them with a precise
   message and source-line caret pointing at the offending column.
2. Add a bare-identifier shorthand for the "pass-through with same name" case
   on both inputs (`password` → `password="{{password}}"`) and outputs
   (`out.session_id` → asserts the skill exposes `session_id` and uses it
   under that name in the caller scope).
3. Keep all existing syntax working unchanged — this is purely additive plus
   stricter error reporting where the regex used to silently fall through.

## Design

### Replace the single regex with a tokenizer

The grammar is small enough to write as a hand-rolled scanner. Splitting it
out of `expander.ts` into `src/skills/skill-call-parser.ts` makes it
independently testable and keeps the expander focused on resolution semantics.

Grammar:

```
SkillCall  := WS? '[skill:' WS Name (WS Arg)* WS? ']' Trailing
Name       := [\w-]+
Arg        := OutAlias | Param
Param      := Identifier ( '=' QuotedString )?    # shorthand: bare identifier
OutAlias   := 'out.' Identifier ( '=' QuotedString )?
Identifier := [\w]+
QuotedString := '"' [^"]* '"'
Trailing   := <anything after the closing ']' — discarded as a human comment>
```

Since [stories/skills-in-subfolders.md](skills-in-subfolders.md), `Name` also
admits `/` — `[\w\-/]+`, still no dots — for path-qualified references to
skills kept in subfolders (`auth/login`, leading slash optional).

`Param` with no `=` desugars to `Identifier="{{Identifier}}"`. `OutAlias` with
no `=` desugars to `out.Identifier="Identifier"` (i.e. no rename, but the
output is still validated against the skill's declared `## Outputs`).

### Detection model: "looks like a skill call"

A line is *committed* to being parsed as a skill call iff it starts with
`[skill:` (after optional leading whitespace). From that point on, any
deviation from the grammar throws `SkillCallSyntaxError` with column info.

Lines that don't start with `[skill:` are returned as `null` and flow through
unchanged — exactly as today.

This means a step like `[skill: dismiss the modal]` (where `dismiss` was meant
as English, not a skill name) will get committed and fail because `the` is
neither `=` nor `]`. That's acceptable: it's a hard rule that any line opening
with `[skill:` is a skill invocation, and the error will be unambiguous.

### Error format

```
[src/skills/skill-call-parser.ts]
SkillCallSyntaxError: unterminated string for argument 'password'
  [skill: login password="{{password}}]
                         ^
```

Specific cases the tokenizer detects:

| Input | Diagnostic |
|---|---|
| `[skill: foo password="abc` | unterminated string for argument 'password' |
| `[skill: foo password=abc"` | expected '"' after '=' for argument 'password' |
| `[skill: foo bar! ]` | unexpected character '!' after argument 'bar' |
| `[skill: ]` | skill name missing |
| `[skill: foo` | unclosed skill invocation: expected ']' |
| `[skill: foo bar="x"baz="y"]` | expected whitespace or ']' before next argument |

### Shorthand desugaring

Implemented in the parser, transparent to the expander.

```
[skill: login username password]
  → args = { username: '{{username}}', password: '{{password}}' }

[skill: get_session out.session_id]
  → outputAliases = { session_id: 'session_id' }

[skill: login username password role="admin" out.session_id]
  → args = { username: '{{username}}', password: '{{password}}', role: 'admin' }
  → outputAliases = { session_id: 'session_id' }
```

The bare-output form is functionally equivalent to omitting the `out.` clause
(an output the skill declares is already accessible under its declared name in
the caller scope), but it is **not** a no-op: it round-trips through
`validateCall`, so it doubles as a documentation-and-assertion that the named
output exists. Mistyping `out.sesion_id` will throw at parse time instead of
silently leaving an unresolved `{{session_id}}` placeholder downstream.

### What's intentionally not supported

- **Positional args.** Concise but brittle; adding a parameter to a skill
  silently shifts every caller. Skip.
- **String escapes inside `"..."`.** Existing regex doesn't support them, no
  one has asked, keep simple.
- **Spaces around `=`.** `key = "value"` will parse as bare-identifier `key`
  followed by a stray `=` and error. Keep grammar tight.

## Implementation outline

1. New file `src/skills/skill-call-parser.ts`:
   - `parseSkillCall(line: string): ParsedSkillCall | null`
   - `class SkillCallSyntaxError extends Error` with `source` and `column`
     fields, formatting a caret diagnostic in `.message`.
2. `src/skills/expander.ts`:
   - Delete `SKILL_INVOCATION_RE` and `ARG_RE`.
   - Replace `parseSkillCall` (the regex one) with a thin adapter calling the
     new parser. `expandRecursive` is otherwise unchanged.
3. New fixture skill `fixtures/skills/fill_login_form.md` with two parameters
   (`username`, `password`) for the shorthand demo.
4. New demo test `fixtures/tests/skill-shorthand-demo.md` exercising the
   shorthand.
5. Tests:
   - `tests/skill-call-parser.test.ts` — unit tests for the tokenizer (happy
     paths, shorthand, every error class with column assertions).
   - `tests/skill-expander.test.ts` — additional cases covering shorthand
     end-to-end through expansion (input shorthand, output shorthand, mixed,
     surfacing of syntax errors).
   - `tests/skill-shorthand-integration.test.ts` — parses the new
     `skill-shorthand-demo.md` fixture via `parseTestFile({ skillsDir })` and
     asserts the expanded step list, exercising the full
     parser→expander pipeline against real fixtures on disk.

## Migration

Existing skill calls already in test files are unaffected — the new parser
accepts every shape the old regex accepted, plus the shorthands. Only
previously-malformed calls (which were silently broken anyway) will now throw,
which is the desired outcome of this change.
