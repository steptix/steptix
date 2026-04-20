---
tags: [smoke, skills]
---

# Skill demo — search and follow first result

Demonstrates `[skill: ...]` invocation. The skill performs the search and
exports `first_result_url`; we rename it to `target_url` in the caller scope
and use it in a follow-up step.

## Steps
1. [skill: duckduckgo_search query="OpenAI GPT-5" out.first_result_url="target_url"]
2. Navigate to {{target_url}} and verify the page has loaded


