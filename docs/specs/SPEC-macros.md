# Macros: the new name for Steptix's `[skill:]` files

**Status:** built.
**Opened:** 2026-11-25
**Scope:** a rename. No new behaviour, no compatibility layer, no version
change.

## 1. Why

Steptix had two features called "skills":

- **Agent Skills**: a folder with a `SKILL.md`, an open format shared with
  Claude Code and other agent tools, loaded by a `[use agent]` step
  (PR steptix/steptix#127). The standard fixes that name, so it stays.
- **Steptix's own `[skill: name …]` files**: a `.md` of steps with
  `## Parameters` and `## Outputs`, inlined wherever it is called. The
  handbook already described them as step macros. This is the feature that
  is renamed.

Sections (`### Section`) are reuse inside one file; macros are reuse across
files. "Macros" was chosen on 2026-11-25 over "shared steps" and "routines".

## 2. The names

| What | Was | Is |
|---|---|---|
| The call in a step | `[skill: login user="ada"]` | `[macro: login user="ada"]` |
| The colon-less call | `[skill login]` | `[macro login]` |
| The file's frontmatter | `type: skill` | `type: macro` |
| The config key | `tests.skillsDir` | `tests.macrosDir` |
| The default folder | `./skills` | `./macros` |
| The step request field (Sessions API, MCP) | `skillsDir` | `macrosDir` |
| The report chip | `skill: login` | `macro: login` |
| Frame kind on the wire and in MCP output | `'skill'` | `'macro'` |
| Frame and step fields | `skillName`, `sourceSkill` | `macroName`, `sourceMacro` |
| A macro body's private variables | `__skill<N>_name` | `__macro<N>_name` |
| Extension command | `steptix.runSkillStepsOnStoppedSession` | `steptix.runMacroStepsOnStoppedSession` |
| Extension context key | `steptix.skillDebugActive` | `steptix.macroDebugActive` |
| Code | `src/skills/`, `skill-call-parser.ts`, `expandSkills`, `SkillCallSyntaxError`, … | `src/macros/`, `macro-call-parser.ts`, `expandMacros`, `MacroCallSyntaxError`, … |
| The word in text | a skill, skills | a macro, macros |

Everything else about the feature is unchanged: the grammar after the
keyword (arguments, `out.` aliases, labels, path-qualified names such as
`[macro: auth/login]`), the file format, the scoping rules, breakpoints,
step-into, code-behind.

The keyword is case-sensitive, as `[skill` was: `[MACRO: x]` is prose. A
markdown link (`[macro guide](./g.md)`) is not a call, and a colon-less token
that does not parse (`Select the [macro lens: 100mm] option`) is prose, exactly
as before. A token followed by more letters (`[macros]`, `[macroscopic]`) is
not a call.

## 3. No compatibility

Steptix is unreleased in this form, so the old names are removed outright
rather than deprecated (decided 2026-11-25). Nothing reads `[skill:`,
`type: skill`, `tests.skillsDir` or a `./skills` folder any more, and no
warning names them. What an old file then does follows from the existing
rules, with no code added for it:

- **`[skill: login]` as a whole step** is an unknown bracket, refused when the
  file is parsed with the message that lists the directives, `[macro: name]`
  among them. It never reaches a model.
- **`Log in [skill: login]`**, with text before it, is a plain step and goes
  to the model as prose, like any other bracketed word.
- **`type: skill`** is an unknown type and is ignored, so test discovery
  lists the file as a test.
- **`tests.skillsDir`** is an unknown key: the runner ignores it, and the
  schema's `additionalProperties: false` makes the editor flag it.
- **A `./skills` folder** is just a folder. What a call to a macro still in
  it does depends on whether a `./macros` folder exists:
  - **With a `./macros` folder**, from any client, the call fails with
    `Macro "login" not found at <root>/macros/login.md`.
  - **On the CLI**, `./macros` is always sent, so the same message appears
    even with no such folder.
  - **In VS Code and MCP with no `./macros` folder**, no macros directory is
    sent (§6). A file with sections or control lines fails with the
    expander's `no macros directory is configured` message. On the computer
    surface, the line is refused unrun. On the page surface, the line goes to
    the model as prose; that gap predates the rename (§6).

## 4. Moving a project

1. Rename the folder: `git mv skills macros` (or set `"tests.macrosDir"` to
   wherever the files are).
2. In `steptix.config.json`, rename `tests.skillsDir` to `tests.macrosDir`.
3. In each macro file, `type: skill` → `type: macro`.
4. In tests, macros and `defaultHooks`, `[skill:` → `[macro:` and a colon-less
   `[skill ` call → `[macro `.

Code-behind needs no change: the call line itself is never compiled, a
macro's `.steps.ts` sits beside its `.md` and moves with it, and its entries
are bound by the macro's name and step text, which the rename leaves alone.

## 5. What ships

- Source, tests and fixtures in `src/`, `runner-core/`, `steptix-vscode/`,
  `flick-vscode/`, `tests/`, `fixtures/`, `templates/` and `scripts/` use the
  new names, and `schema/steptix.config.schema.json` is regenerated.
- The docs that describe the product as it is now — the handbook, the AI
  test-authoring guide, the README and the specs under `docs/specs/` — use
  the new names.
- History keeps the old ones: `stories/`, `issues/`, `ideas/`,
  `steptix-vscode/stories/`, `docs/unit-test-review/` and older CHANGELOG
  entries say `[skill:]` on purpose; read it as `[macro:]` there. Links into
  those folders keep their old file names.
- Agent Skills are untouched. Main has none of their code yet; PR
  steptix/steptix#127 brings `agent.skillsDir`, `SKILL.md` and `src/agent/`
  with their own name.

## 6. The editor finds the default folders

The handbook says a project's macros live in `macros/` unless
`tests.macrosDir` says otherwise, and the CLI and MCP have always applied
that default (`src/config/defaults.ts`; `resolveProjectDir` in
`src/mcp/project.ts`). The VS Code extension did not: it read only a
*declared* `tests.macrosDir` / `tests.toolsDir`, so in a project relying on
the default it sent the server no folder. The server then expanded nothing,
and on the browser surface a `[macro: x]` line went to the model as prose;
completion and Go to Definition offered nothing. That gap predates the
rename. It is closed here because the rename puts the default in every doc.

The rule:

- A declared, non-empty `tests.macrosDir` / `tests.toolsDir` is used as
  written, resolved against the folder holding `steptix.config.json`, whether
  or not it exists. A wrong path then fails loudly at the call:
  `Macro "x" not found at …`. MCP differs here: `resolveProjectDir` drops a
  declared folder that does not exist, as it drops a missing default.
- An undeclared one (absent, empty, or not a string) is the default,
  `./macros` / `./tools/src` beside the config, **when that folder exists**,
  and otherwise none.
- Existence is checked on every read, not cached with the config, so a
  `macros/` folder created after the window opened is found without a
  reload or a config edit.
- With no `steptix.config.json` above the test there is no project root to
  resolve a default against, so there is no folder, as before.

When there is no folder, Go to Definition on a macro name says
`Steptix: no macros folder — steptix.config.json sets no tests.macrosDir and has no macros folder beside it.`
(and the same for tools, naming `tests.toolsDir` and `tools/src`).
