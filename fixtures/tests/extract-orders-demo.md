---
tags: [tools, arrays, api, demo]
timeout: 60s
---

# Tool returns an array — extract every recent order id

Demonstrates a tool emitting a `string[]` back into the test variable scope.
The shape is symmetric to `read multiple: true`: both produce a JSON-encoded
list in `resolvedParameters`, which downstream tools can decode via an
array-typed parameter.

## Config
- baseUrl: ${env.BASE_URL}

## Notes

- Step 1 calls the tool with no status filter — `order_ids` ends up being
  every order in the last 30 days.
- Step 3 calls the SAME tool with `status="failed"`, but uses output aliases
  (`out.order_ids="failed_ids"`, `out.order_count="failed_count"`) so the
  results land in different variables and don't overwrite the first call.
- The downstream assertions in steps 2/4/5 use `{{...}}` interpolation,
  which substitutes the tool's outputs into the step text. After
  substitution the resolved instructions read like
  `Assert that 8 is at least 5` — pure predicates with no DOM lookup.
  The framework's assert action handles these via `against: 'predicate'`
  (set automatically by the AI) so they run in TS without a DOM context.
- A subsequent tool that declared `ids: { type: 'string[]' }` and was called
  with `ids="{{failed_ids}}"` would receive a real `string[]` ready to loop.

## Steps
1. [tool: extract_order_ids sinceDays=30 baseUrl="${env.BASE_URL}"]
2. Assert that {{order_count}} is at least 5
3. [tool: extract_order_ids sinceDays=30 status="failed" baseUrl="${env.BASE_URL}" out.order_ids="failed_ids" out.order_count="failed_count"]
4. Assert that {{failed_count}} equals 2
5. Assert that {{failed_ids}} contains "O-1003" and "O-1007"

<!-- latest-runs:start -->
## Latest runs

- [2026-05-04 12:21:50Z — passed — openrouter/deepseek/deepseek-v4-flash:nitro](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_12-21-50-tool-returns-an-array-extract-every-recent-order-id.html)
- [2026-05-04 11:36:52Z — failed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_11-36-52-tool-returns-an-array-extract-every-recent-order-id.html)
- [2026-05-04 11:35:59Z — failed — openrouter/deepseek/deepseek-v4-flash:nitro](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_11-35-59-tool-returns-an-array-extract-every-recent-order-id.html)
- [2026-05-04 11:35:56Z — failed — openrouter/deepseek/deepseek-v4-flash:nitro](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_11-35-56-tool-returns-an-array-extract-every-recent-order-id.html)
- [2026-05-04 11:23:50Z — failed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_11-23-50-tool-returns-an-array-extract-every-recent-order-id.html)
<!-- latest-runs:end -->
