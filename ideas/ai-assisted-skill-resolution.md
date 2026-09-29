# AI-assisted skill resolution

Idea: when the deterministic skill-call parser can't make sense of a line, ask
the model to interpret it and return the canonical `[skill: ...]` form (or
expand it directly). Three rough shapes worth weighing, in increasing order of
"magic."

## Shape A — AI fixes broken syntax (fallback only)

Trigger: `parseSkillCall` throws `SkillCallSyntaxError`.

Flow: send the offending line, the syntax error message, and the list of
available skill names + their parameter/output schemas to the model. Ask "did
the author mean a skill call? if so, return the canonical form." Surface the
suggestion to the author as a diagnostic ("did you mean: ..."); don't
auto-apply.

Properties:
- Deterministic path stays authoritative — AI only repairs typos.
- No cost on the happy path.
- Failure mode is bounded: worst case, the author rejects the suggestion and
  fixes the line by hand — the same place they are today.

## Shape B — AI resolves natural-language skill references

Author writes `Log in as alice` with no `[skill: ...]` marker at all. At parse
time the resolver checks each step against the skill catalogue and asks the
AI "does this line correspond to one of these skills, with what parameters?"
If confidence is high, expand it.

Properties:
- Most powerful — closest to "natural language is the syntax."
- Highest risk: a step that *looks* like prose silently invokes a skill.
  Reviewers can no longer tell a skill is being called by reading the test.
- Confidence threshold becomes a tunable, and getting it wrong is invisible
  until something misbehaves at runtime.

## Shape C — Schema-aware parameter inference inside an explicit call

Author writes `[skill: fill_login_form for the admin user]`. The skill marker
is still explicit; the args are free-form English; the AI matches them against
the skill's declared parameters.

Properties:
- Compromise: keeps the visual marker so reviewers see a skill is invoked.
- Lower risk than B because the skill name is committed.
- Still pays the AI cost on every parse for this kind of call, with the same
  determinism caveats as B.

## Tradeoffs that apply to all three shapes

- **Determinism vs. magic.** Today, parse-time expansion is fully
  deterministic, cacheable, and reproducible across runs. AI involvement at
  parse time means the test's expansion can vary between runs — which has
  real consequences for the prompt cache and the assertion-code cache, both
  keyed on the expanded steps.
- **Cost & latency.** Parse-time AI calls are paid on every test load,
  including the watch loop and Steptix's live preview. Caching by
  line-hash is feasible but adds another cache to reason about.
- **Failure mode.** A deterministic parser fails fast and obviously. An AI
  fallback fails *plausibly* — it returns a wrong skill confidently — and
  that's much harder to debug.
- **Author intent.** The bare-identifier shorthand we just shipped is a
  syntactic compression of a fully-specified call. AI inference is a
  different beast: it's guessing at intent. Worth keeping that line crisp
  rather than blurring "this is shorthand" with "this is a guess."

## Recommendation

Start with **Shape A** if we move on this at all: invoke the AI only on a
`SkillCallSyntaxError`, present the suggestion as an editor diagnostic the
author can accept (similar to a "did you mean?"), and never auto-apply at
test-run time. It captures the upside (no more silent unclosed-quote pain
even when the diagnostic itself isn't enough to figure out what was meant)
without compromising determinism for tests that already parse.

Shapes B and C are larger product decisions about how implicit skill
invocation should feel. Defer until there's a concrete pain story that the
deterministic path + Shape A can't solve.
