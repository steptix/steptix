---
type: skill
---

# audit_monthly_statement

Reusable monthly-statement audit for SecureBank. Assumes the caller has
already signed in. Verifies the dashboard balance, navigates to the
Transactions page, filters to the given month, and asserts that a known
salary credit row plus the expected minimum row count are present. Captures
the filtered-period sub-heading text so the caller can assert against it.

## Parameters
- month: human-readable month label to select in the Month filter (e.g. "March 2026")
- minBalance: minimum dashboard balance the caller expects (numeric, in dollars)
- expectedSalary: formatted salary credit string expected in the filtered table (e.g. "+$2,800.00")
- minTransactions: minimum number of transaction rows expected after filtering

## Outputs
- period_label: the sub-heading text describing the filtered period

## Steps
1. Verify the dashboard shows a balance greater than {{minBalance}}
2. Click "Transactions" in the sidebar and verify the Transactions page loads
3. In the Month filter dropdown, select "{{month}}"
4. Verify at least {{minTransactions}} transaction rows are visible
5. Verify a transaction row with the amount "{{expectedSalary}}" is visible
6. Capture the descriptive text below the page heading that names the filtered period [store as: period_label]
