---
tags: [smoke, tools, arrays]
---

# Array-loop demo — extract a list of links, visit each one in a tool

Demonstrates the arrays-in-tools pipeline:
1. `read multiple: true` captures every matching value as a JSON-encoded list.
2. `[tool: visit_each urls={{...}}]` receives a typed `string[]` and loops in
   TypeScript without any AI involvement.
3. The tool emits its own list output (`titles`) which downstream steps can
   assert on.

## Config
- baseUrl: ${env.BASE_URL}

Authoring notes:
- The framework's only parser-level marker on step 1 is `[as: nav_links]` —
  that names the captured variable. The AI decides to set `multiple: true`
  on the emitted `read` action because the step text uses plural language
  ("every", "all", "each") — see prompt rule 13a. There is no markdown
  shorthand for `multiple`; the trigger is purely natural-language.
- `visit_each` declares `urls: { type: 'string[]' }` — the framework
  JSON-decodes the captured list at the bridge boundary, so the tool's
  `run({ urls })` receives a real `string[]`.
- Tool args expecting an array can be supplied three ways:
  - `urls="{{nav_links}}"` — quoted whole-arg reference (most common)
  - `urls` — bare-identifier shorthand expands to `urls="{{urls}}"`
  - `urls=["https://a.example", "https://b.example"]` — inline JSON literal

## Steps
1. Read every navigation link's href as a list [as: nav_links]
2. [tool: visit_each urls="{{nav_links}}"]
3. Assert that the visited_count matches the number of nav_links
