---
type: skill
dataSources:
  engine: ../data/search-engine.json
---

# site_search

Searches a fixed search engine for a caller-supplied term and exposes the first
result's URL.

This skill deliberately mixes the two ways a skill gets its values:

- **`query`** is a `## Parameters` input — the *caller* passes it, and it can
  differ on every call (referenced as `{{query}}`).
- **`${engine.name}` / `${engine.baseUrl}`** come from the skill's OWN `engine`
  dataSource (`fixtures/data/search-engine.json`) — static values the caller
  never supplies. The relative path resolves against *this skill file's*
  directory, and the `${…}` placeholders are filled in at expansion time.

## Parameters
- query: the term to search for

## Outputs
- first_result_url: the URL of the first organic search result

## Steps
1. Navigate to ${engine.baseUrl} and verify the ${engine.name} search box is visible
2. Type "{{query}}" into the search box, wait for the suggestions dropdown to appear, and press Enter
3. Verify search results are displayed for "{{query}}"
4. Capture the href of the first organic search result link as a full URL [store as: first_result_url]
