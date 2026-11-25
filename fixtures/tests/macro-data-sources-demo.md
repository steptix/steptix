---
tags: [smoke, macros, data]
timeout: 120s
---

# Macro-level dataSources — env-driven URL inside the macro

Demonstrates a macro that reads its **own** JSON data file based on the
active environment. The macro `open_dashboard_for_env` declares
`dataSources: endpoints: ../data/${envName}-endpoints.json` in its
frontmatter — so:

- `steptix run … --env local`   → macro loads `fixtures/data/local-endpoints.json`
- `steptix run … --env staging` → macro loads `fixtures/data/staging-endpoints.json`
- `steptix run … --env uat`     → macro loads `fixtures/data/uat-endpoints.json`

The test itself stays env-agnostic: it just invokes the macro. The macro
exports the page title as an output, which the test renames to
`loaded_title` and asserts against — proving the macro ran end-to-end and
that output passing across the macro boundary still works.

## Steps
1. [macro: open_dashboard_for_env out.page_title="loaded_title"]
2. Verify "{{loaded_title}}" contains "SecureBank"
