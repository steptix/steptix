---
type: skill
---

# duckduckgo_search

Reusable DuckDuckGo search flow. Navigates to the homepage, runs a query, and
exposes the rendered first result link as an output.

## Parameters
- query: the search term to enter

## Outputs
- first_result_url: the URL of the first organic search result

## Steps
1. Type "{{query}}" into the search box, wait for the suggestions dropdown to appear and press Enter
2. Verify search results are displayed for "{{query}}"
3. Capture the href of the first organic search result link as a full URL [store as: first_result_url]
