---
type: skill
dataSources:
  site: ../data/securebank-site.json
---

# open_site_page

Opens a page of the SecureBank fixture app by path and exposes its main
heading.

This skill deliberately mixes the two ways a skill gets its values:

- **`page`** is a `## Parameters` input — the *caller* passes it, and it can
  differ on every call (referenced as `{{page}}`).
- **`${site.name}` / `${site.baseUrl}`** come from the skill's OWN `site`
  dataSource (`fixtures/data/securebank-site.json`) — static values the caller
  never supplies. The relative path resolves against *this skill file's*
  directory, and the `${…}` placeholders are filled in at expansion time.

## Parameters
- page: the page path under the site root, e.g. `transactions`

## Outputs
- page_heading: the text of the page's main heading

## Steps
1. Navigate to ${site.baseUrl}/{{page}} and verify the page title starts with "${site.name}"
2. Capture the text of the page's main heading (the h1) [store as: page_heading]
