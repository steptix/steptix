# 060 — A `[use ai]` step that needs a secret stores `***` and passes

**Status:** open / known issue. Found by a real-model probe while building
[stories/use-ai-step.md](../stories/use-ai-step.md); left as a known issue by
the user's decision, 2026-09-24.
**Area:**
[src/runner/use-ai-step-runner.ts](../src/runner/use-ai-step-runner.ts)
(`runUseAiStep`, step 2: placeholders are filled, then secret-named values
masked with `maskValueForPrompt`);
[src/ai/prompts.ts](../src/ai/prompts.ts) (`buildUseAiPrompt`, the system
prompt, which does not say what `***` means).
**Related:** decision 4 of the story ("a step cannot compute from a secret;
that is the right trade"); [secret-redaction](../stories/secret-redaction.md).
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
