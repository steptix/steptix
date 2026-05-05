---
tags: [smoke, skills, data]
timeout: 180s
dataSources:
  statement: ../data/march-statement.json
---

# Statement audit — skill parameters sourced from a data file

Combines several framework features in one flow:

- `dataSources` declares a custom JSON namespace (`statement`) loaded from a
  file alongside the env defaults — every value resolves via
  `${statement.X.Y}` at parse time.
- `## Hooks` wrap the body with sign-in / sign-out so the audit step runs
  from an authenticated state, with credentials pulled from the same data
  file.
- `[skill: audit_monthly_statement ...]` delegates the audit body to a
  reusable skill; every skill parameter is fed from the data file, so
  swapping the JSON file (or pointing `dataSources.statement` at a different
  path) re-targets the audit without touching the test or the skill.
- `out.period_label="audited_period"` renames the skill's output into the
  caller's variable scope so the follow-up step can assert against it via
  runtime `{{audited_period}}` interpolation.

## Config
- baseUrl: ${env.BASE_URL}

## Hooks
- before: Navigate to {{baseUrl}}/ and dismiss the cookie banner if visible
- before: Sign in with email "${statement.user.email}" and password "${statement.user.password}"
- after: Click the "Sign out" button in the sidebar

## Steps
1. [skill: audit_monthly_statement month="${statement.march.filterMonth}" minBalance="${statement.march.minBalance}" expectedSalary="${statement.march.expectedSalary}" minTransactions="${statement.march.minTransactions}" out.period_label="audited_period"]
2. Verify "{{audited_period}}" contains "${statement.march.filterMonth}"
