---
tags: [smoke, skills, data]
timeout: 120s
---

# Skill demo — caller parameters + static skill data

The `site_search` skill shows the two ways a skill gets values, side by side:

- **`query`** is passed in by *this test* (a `## Parameters` input). Note it
  differs between the two calls below — that's the caller varying it.
- the search engine's **name and URL** come from the skill's own `engine`
  dataSource (`fixtures/data/search-engine.json`) — static, identical on every
  call, and never set by this test.

> **Run with an environment selected.** A skill's `${…}` dataSource only
> resolves when the run supplies an env. In the TestBench sidebar pick an env
> (e.g. **local**) before running; on the CLI use `aiui run … --env local`.
> (Any env works — the engine file has no `${envName}` in its path, so it's the
> same file every time.)

## Steps
1. [skill: site_search query="OpenAI GPT-5" out.first_result_url="gpt5_url"]
2. Navigate to {{gpt5_url}} and verify the page loaded
3. [skill: site_search query="Playwright end-to-end testing" out.first_result_url="pw_url"]
4. Verify "{{pw_url}}" starts with "http"
