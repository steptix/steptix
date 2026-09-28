# 060 — A `[use ai]` step that needs a secret stores `***` and passes

**Status:** resolved 2026-09-29 — see [Resolution](#resolution). Found by a
real-model probe while building [stories/use-ai-step.md](../../stories/use-ai-step.md).
**Area:**
[src/runner/use-ai-step-runner.ts](../../src/runner/use-ai-step-runner.ts)
(`runUseAiStep`, step 2: placeholders are filled, then secret-named values
masked with `maskValueForPrompt`);
[src/ai/prompts.ts](../../src/ai/prompts.ts) (`buildUseAiPrompt`, the system
prompt, which does not say what `***` means).
**Related:** decision 4 of the story ("a step cannot compute from a secret;
that is the right trade"); [secret-redaction](../../stories/secret-redaction.md).
**Opened:** 2026-09-24

## Summary

A `[use ai]` step sends the model its own text with placeholders filled in,
and every secret-named value masked as `***` (decision 4). That half is
correct: the secret never leaves the machine. But the model is not told what
`***` is, so when the step needs the value, the model treats the three
asterisks as the value. The step passes, and the variable holds a literal
`***`. That is a silent wrong value, the failure this codebase ranks worst,
because every later step that uses the variable will type or compare `***`
and fail somewhere else, or pass against the wrong thing.

## What it looks like

A real-model probe against a Sessions API server built from this branch, on
2026-09-24:

```
POST /sessions/useai-probe-secret/steps
{
  "steps": ["[use ai] Repeat this back exactly, character for character: {{password}} and store it in echo"],
  "parameters": { "password": "hunter2-probe" }
}
```

The result row:

```json
{ "status": "passed", "outputs": { "echo": "***" } }
```

What the model received as its user message (masked, as designed):

```
Repeat this back exactly, character for character: *** and store it in echo
```

What the author would expect: the step fails and says it needed a value it
was not allowed to see. The story's own promise is that a refusal fails the
step, not that a guess or a placeholder is stored.

## Proposed fix

Add one sentence to the `buildUseAiPrompt` system prompt, alongside the
existing "do not guess" rule:

> `***` stands for a value that is hidden from you. If the step needs that
> value, reply with "error" and say so.

This explains the framework's own mask. It does not add any context about
the test, so it keeps the user's rule that the step text is everything the
model knows. With the real model, the two other "cannot be done as written"
probes on the same day (a date with no today given, a value with no name)
both came back as `error`, so the prompt's error rule is followed in
practice.

A deterministic backstop is possible too: fail the step when the stored value
equals, or contains, the literal `***` that the step's own masking put into
the text. That is cheap, but it needs care. A step that legitimately asks for
asterisks (for example "a password field mask of three stars") would be
refused, so the check should only apply when the step's text actually had a
value masked.

Either change needs a unit test in `tests/use-ai-step-runner.test.ts` with a
fake model that echoes its input, and the prompt change needs one real-model
check, since the fix is the model's behaviour.

## Revisit when

- Someone writes a `[use ai]` step over a secret-named variable and asks why
  a later step typed `***`.
- The system prompt for `[use ai]` is next touched for any other reason.

## Resolution

Fixed on 2026-09-29, both halves of the proposal, then widened after a review
of the fix found three ways past it.

- **The prompt.** When a step's text had a value masked, `buildUseAiPrompt`
  adds: "Each *** in the step stands for a value that is hidden from you. If the
  step needs a hidden value, reply with "error" and say so." A step that masked
  nothing gets exactly the prompt it had before, so the author's own asterisks
  ("a row of ***") are never described as hidden.
- **The backstop.** `runUseAiStep` records what its masking hid. If anything
  was hidden and the model's value holds the mask, the step fails through the
  ordinary failure path, is not retried, and stores nothing. The value is
  normalised first, because an echo is not always three ASCII asterisks:
  lookalikes (`＊` U+FF0A, `∗` U+2217, `⁎` U+204E, `✱` U+2731, `﹡` U+FE61, and
  `⁂` / `⁑`, which are three and two in one character) become `*`, backslashes
  are dropped, and so is whitespace or one punctuation mark between two
  asterisks. So `* * *`, `\*\*\*`, `＊＊＊` and `*-*-*`, which the first
  version stored, fail too. A computed or partial form, such as the mask's
  length "3" or one asterisk of the three, cannot be told from an answer, and
  is left to the prompt sentence. Once something was hidden, asterisks the
  model writes for its own reasons also fail, now including `**a** **b**`,
  which closes up to four in a row. That failure is loud and fixable, where the
  old pass was silent.
- **The errors name what was hidden, never a value.** Both of them: the
  backstop's, and the model's own reason when it declines, which says that
  something is hidden but not what.

  ```
  The value contains `***` — the mask for `{{password}}`, which is hidden from the model; a [use ai] step cannot use a secret. `{{password}}` is hidden by its name, which contains "password"; if it is not a secret, rename it.
  The model could not do the [use ai] step as written: The value to repeat is hidden. (Hidden from the model: `{{password}}`.) `{{password}}` is hidden by its name, which contains "password"; if it is not a secret, rename it.
  ```

  The last sentence appears only for a value hidden by its name. That is the
  one mask renaming lifts, and it has a likely false positive: `{{keyword}}`
  contains `key`. A known secret inside a longer value is named as "part of
  `{{greeting}}`", with no rename advice, since the name is not the reason.
  Inside a skill the name is the one the author wrote, `{{token}}`, not the
  `{{__skill1_token}}` that skill scoping renames it to.
- **Skills and looped sections.** The expander writes a skill argument or a
  looped section's row value into the step's text before the step runs
  (`src/skills/expander.ts`: `interpolate(text, call.args)` in
  `applySkillScope`, and the row interpolation in `checkedRowInterpolate`). No
  `{{…}}` was left for the name rule, so neither the sentence nor the backstop
  applied: a `password` column reached the model as `Repeat row-SECRET-1
  exactly`, and the echo passed. The runner now also masks the step's own words
  with the loop's secret set, through a `literal` hook on `resolveUseAiText`
  that never sees a reference, and counts any change as "a secret written into
  the step's text". That needed the set to hold those values, and it did not:
  - The CLI's `secretsNow()` held no skill argument or row value at all, which
    also printed them in clear on the console and in the report. It now pools
    every frame's `inputs`.
  - The Sessions API merged them into one map with the variables, and a map
    keeps one value per name. A second row's `password` evicted the first
    row's (measured: row 1 reached the model in clear, row 2 was masked). And
    `[skill: login password="{{password}}"]`, the ordinary way to hand a login
    skill the password, evicted the test's real password for the whole run
    (measured: `Step 2/2: Type hunter2-real into the password field` on the
    server's console). `runSecretsWithInputs` (`src/utils/secrets.ts`) judges
    each frame's values on their own and pools them. The CLI and the Sessions
    API use it for everything they mask, and the Electron adapter for a
    `[use ai]` step's text.
  - The words are masked with the same set as the report, and that set puts no
    length floor on a value whose name the author chose. So a short secret
    hides those characters anywhere in the step, as it does in the report: a
    `keyword` of `AU` turns "AUstralia" into "***stralia", and the step is told
    something is hidden. `unmask:` exempts a value the runner can look up by
    name. A skill argument or a section column under an unmasked name is not in
    the variable map, so it stays masked in the text.

The real-model check, against a server built from the first version of the fix
(`openai/gpt-5.6-luna`):

```
[use ai] Repeat this back exactly, character for character: {{password}} and store it in echo
  → failed, nothing stored: "The model could not do the [use ai] step as written: The value to repeat is hidden."
[use ai] Write the single word OK and store it in ok. (Unrelated reference, do not use it: {{password}})
  → passed
[use ai] Write the word hello in bold Markdown (…) and store it in bold
  → passed, stored "**hello**"
```

The model now declines by itself; the backstop covers a model that doesn't.
The prompt the model is sent has not changed since. The first line's message
has: it now carries the names, as in the second example above. That wording is
proven by the unit tests, not by a second real-model run.

Tests: `tests/use-ai-step-runner.test.ts` (an echoing fake model, the
trade-off, the echo spellings, the names in both errors, `otherwise continue`,
records, several references, the step's own words),
`tests/api-server-use-ai.test.ts` (the probe, a two-row section, a skill
argument, and the shadowing skill argument, through the real Sessions API
route), `tests/use-ai-runner-cli.test.ts` (a two-row section and a skill
argument through `runTest`), `tests/ui-runner-adapter-use-ai.test.ts` (a
two-row section) and `tests/secrets.test.ts` (`runSecretsWithInputs`).

Found alongside, not fixed here:

- `unmask:` is honoured only by `aiui run`. TestBench never sends
  `config.unmask` (`runner-core/src/api-client.ts`, and the run controller in
  `testbench-native/src/extension/run-controller.ts`), and MCP, Flick, the
  errand runner and the Electron adapter do not pass it either. On every path
  but the CLI, a name that only looks secret stays masked, and such a step now
  fails there instead of storing `***`. Renaming the variable works
  everywhere, which is why the errors suggest that and not `unmask:`.
- The Sessions API's JSON response puts the expanded line in `results[].step`,
  so a skill argument or a row value appears there in clear. The streamed
  events do not carry it, apart from `frame:scope`, whose scope the client
  masks by name.
- The Electron adapter's step lines, report and `## Prior Steps` history still
  mask without skill arguments and row values. Only its `[use ai]` text uses
  them, so a page step in a looped section can still show the page model a
  `password` column in a later step's history.
- A `[use ai]` line typed into the CLI REPL or the Electron steer box is not
  recognised as a `[use ai]` step.
