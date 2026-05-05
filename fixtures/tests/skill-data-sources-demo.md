---
tags: [smoke, skills, data]
timeout: 120s
---

# Skill-level dataSources — env-driven URL inside the skill

Demonstrates a skill that reads its **own** JSON data file based on the
active environment. The skill `open_dashboard_for_env` declares
`dataSources: endpoints: ../data/${envName}-endpoints.json` in its
frontmatter — so:

- `aiui run … --env local`   → skill loads `fixtures/data/local-endpoints.json`
- `aiui run … --env staging` → skill loads `fixtures/data/staging-endpoints.json`
- `aiui run … --env uat`     → skill loads `fixtures/data/uat-endpoints.json`

The test itself stays env-agnostic: it just invokes the skill. The skill
exports the page title as an output, which the test renames to
`loaded_title` and asserts against — proving the skill ran end-to-end and
that output passing across the skill boundary still works.

## Steps
1. [skill: open_dashboard_for_env out.page_title="loaded_title"]
2. Verify "{{loaded_title}}" contains "SecureBank"
