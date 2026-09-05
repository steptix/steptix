---
tags: [variables, demo]
timeout: 60s
---

# Build a variable out of variables with `Set`

Every other way a variable gets a value reads it from somewhere outside the
test — the page, a tool, a parameter, an environment file. `Set {{name}} to
"…"` is the one that builds a value out of values the run already holds.

It runs as **code**: no AI call, no page interaction, no cache entry. This
whole file costs zero tokens, which is why it is also the cheapest end-to-end
check that the framework's variable plumbing works — it passes with no API key
configured at all.

## Notes

- **The right-hand side is always a double-quoted string.** Copying one
  variable to another is `Set {{copy}} to "{{original}}"`; there is no
  bare-name form. Quoting is what separates an assignment from prose about the
  page (`Set the filter to Recent` is an ordinary AI step and stays one).
- **Text only.** `"{{n}} + 1"` stores those five characters. Anything that
  *computes* belongs in a tool — see `regex-extract-demo.md`.
- **The last quote on the line closes the value**, so an inner quote needs no
  escaping (step 5).
- **An unresolvable `{{name}}` fails the step**, naming it. Storing the literal
  `{{typo}}` would pass green here and break a later step instead.

## Parameters
- username: demo@securebank.com
- region: au

## Steps
1. Set {{greeting}} to "Hello"
2. Set {{summary}} to "{{greeting}}, {{username}} ({{region}})"
3. Set {{copy}} to "{{summary}}"
4. Set {{cleared}} to ""
5. Set {{quoted}} to "she said "hi" twice"
6. Set {{summary}} to "{{summary}} — revised"
