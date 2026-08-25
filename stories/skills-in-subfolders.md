# Skills in subfolders

## What we're building

Today every skill has to sit directly in the skills directory — `skills/login.md`,
`skills/capture_url.md` — because a `[skill: ...]` reference is a flat name. A
project with a dozen skills ends up with one undifferentiated pile.

After this story, skills can live in subfolders and steps reference them
path-qualified:

```
skills/
  capture_url.md
  auth/
    login.md
    reset_password.md
  admin/
    users/
      create_user.md
```

```markdown
1. [skill: auth/login username="{{username}}" password="$ADMIN_PW"]
2. [skill: /admin/users/create_user role="viewer"]   # leading slash also accepted
3. [skill: capture_url out.url="dashboard_url"]      # flat names keep working
```

Both spellings name the same file: `[skill: auth/login]` and
`[skill: /auth/login]` resolve `<skillsDir>/auth/login.md`. The **canonical
form has no leading slash** (`auth/login`) — matching how path-qualified tool
references already read — and that is the form everything downstream displays:
cycle-detection errors, the report's skill badge, the debugger's frame
`skillName`, "skill not found" messages.

## Why the grammar change is safe

`[skill:` and `[tool:` share one tokenizer (`parseInvocation` in
`src/parser/invocation-parser.ts`). Tool calls already opt into
`allowSlashInName` for `dir/file/tool` references; skills simply stop being
the odd one out. The name character class with slashes enabled is `[\w\-/]` —
**no dots, no backslashes** — so `..` is unlexable and a path-qualified skill
reference can never traverse out of `skillsDir`. No containment check is
needed beyond the grammar; `loadSkill`'s `path.resolve(skillsDir, name + '.md')`
stays as-is and simply lands in a subfolder.

Malformed paths are parse errors, not silent prose: `[skill: auth//login]`,
`[skill: auth/]` and `[skill: /]` throw `SkillCallSyntaxError`
("empty path segment") with the caret on the name, same as every other
grammar violation.

## Where the name canonicalises

In exactly one place: `parseSkillCall` (`src/skills/skill-call-parser.ts`)
strips the leading slash and validates segments before returning. Every
consumer — the expander (cycle keys, frames, `sourceSkill` attribution), the
server's step-mode expansion, MCP's code-step detection — receives the
canonical name, so `/auth/login` and `auth/login` can never be two different
skills in a `visited` set or two different badges in a report.

What deliberately does **not** change:

- **`skill.name` still comes from the H1** inside the file. The invocation
  name is a file locator; the H1 is the display/validation name
  (`validateCall` messages). Unchanged relationship.
- **Frames carry `uri: skill.filePath`** — already absolute, so breakpoints,
  step-into, call-stack, codebehind snapshots (`.aiui-codebehind-cache`
  beside the skill file, now beside it *in its subfolder*) all work untouched.
- **Skill cache keys** are the resolved absolute path + env name. Unchanged.
- **runner-core** — treats skill names as opaque display strings
  (`protocol.ts` `skillName`) and `[`-leading steps as directives
  (`section-index.ts`). No change needed.
- **`CODE_STEP_PATTERN`** (MCP's "is this a code step" detector) matches the
  `[skill:` prefix only. Unchanged.

## Editor support (testbench-native)

Three things in the extension know the shape of a skill name and need to learn
slashes; this is bundled-extension code, so **bump the patch version**
(0.5.83 → 0.5.84) per the repo rule.

1. **Go to Definition** (`definition-provider.ts`): `INVOCATION_RE`'s name
   class `[A-Za-z0-9_-]+` widens to include `/`. `skillNameTarget` /
   `skillOutputTarget` strip a leading slash and `path.join` into the
   subfolder.
2. **The tool branch of the same regex** — widening the class means
   `[tool: auth/login/login]` now captures the full ref where it previously
   captured only `auth`, so `toolNameTarget` must implement the real
   resolution rule (mirroring `parseToolRef` in `src/tools/registry.ts`):
   the **last** segment is the tool name, everything before it is the file —
   `auth/login/login` → `<toolsDir>/auth/login.ts`. A single segment stays
   sugar for "file named after the tool". This repairs a latent misparse
   rather than adding scope: today F12 on a path-qualified tool ref looks up
   the wrong file.
3. **Completion** (`section-providers.ts` `skillNames`): the flat
   `readdirSync` becomes a recursive walk emitting `auth/login`-style names
   (forward slashes on every platform), so subfolder skills appear in the
   `[skill: ...]` snippet list.

Statuses, breakpoints and the call-stack view key off frame `uri`s and are
indifferent.

## Tests

Root vitest suite:

- `tests/skill-call-parser.test.ts` — `auth/login` parses as the name;
  `/auth/login` canonicalises to `auth/login`; `auth//login`, `auth/`, `/`
  throw `SkillCallSyntaxError` matching /empty path segment/; args and
  `out.` aliases unaffected on a path-qualified call.
- `tests/skill-expander.test.ts` — a skill at `<tmp>/auth/login.md` expands
  via `[skill: auth/login ...]` and via `[skill: /auth/login ...]` (same
  steps, `sourceSkills` tagged `auth/login` in both); a missing subfolder
  skill reports `Skill "auth/nope" not found at <full path>`; cycle
  detection treats `[skill: a/x]` and `[skill: /a/x]` as the same skill
  (mutual recursion across the two spellings still errors).

The extension providers are thin VS Code glue with no existing unit harness —
covered by the shared-grammar tests above plus manual F12/completion checks.

## Docs

- `README.md` Skills section: subfolders allowed, referenced
  `[skill: subfolder/name]`, leading slash optional.
- `src/mcp/tools.ts` `STEP_SYNTAX` teaching text: note the `sub/name` form.
- `stories/skill-call-syntax.md`: one-line note that the Identifier
  production now admits `/` for skills too (this story).

## Acceptance

1. A test with `1. [skill: auth/login username="u" password="p"]` runs the
   subfolder skill's body; the report badge and any cycle/load errors say
   `auth/login`.
2. `[skill: /auth/login ...]` behaves identically.
3. `[skill: auth//login]` fails the parse with "empty path segment", caret on
   the name.
4. F12 on the name jumps to `skills/auth/login.md`; completion offers
   `[skill: auth/login]`.
5. Flat skills (`[skill: capture_url]`) behave exactly as before; full vitest
   suite green.
