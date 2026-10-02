---
tags: [smoke, data]
timeout: 120s
dataSources:
  catalog: ../data/demo-catalog.json
---

# Named dataSource demo (test-level)

This test declares its OWN named JSON namespace — `catalog` — in frontmatter and
reads values from it with `${catalog.X.Y}`. The file loads and its values are
substituted at parse time; the (relative) path resolves against THIS test file's
directory, so the suite stays portable.

When to use it: a named dataSource is for a fixed, explicitly-named catalog of
inputs (a record, a target list) — as opposed to the env-default `${data.*}`,
which auto-loads `fixtures/data/<envName>.json` purely from the selected env.

Two things to know:

- **Static path.** A *test-level* dataSource path does NOT interpolate
  `${envName}`. For a source whose *file* changes per environment, declare the
  dataSource on a **skill** (e.g. `endpoints: ../data/${envName}-endpoints.json`,
  see `fixtures/skills/open_dashboard_for_env.md`) and call it from the test.
- **Where it resolves.** Run on the CLI with an env so the parse-time data load
  kicks in: `steptix run fixtures/tests/named-datasource-demo.md --env local`.
  (Skill-level dataSources additionally resolve in the Steptix, since skills
  are parsed server-side during expansion.)

## Steps
1. Navigate to ${catalog.site.url}${catalog.page.path} and verify the page title starts with "${catalog.site.name}"
2. Verify the page's main heading reads "${catalog.page.heading}"
