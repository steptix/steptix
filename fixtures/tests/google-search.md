---
tags: [smoke, external]
timeout: 30s
---

# Google Search Smoke Test

## Config
- baseUrl: https://www.google.com

## Steps
1. Navigate to the Google homepage and verify the search box is visible
2. Type "OpenAI GPT-5" into the search box and press Enter
3. Verify that search results are displayed and at least one result contains the text "OpenAI"
4. Click on the first search result
5. Verify that the page has navigated away from Google to a new website
