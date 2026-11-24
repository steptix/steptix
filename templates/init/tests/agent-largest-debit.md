---
tags: [live-integration, agent]
---

# [use agent] live test: the largest debit

Fixture for a live `[use agent]` run (docs/specs/SPEC-use-agent.md). Step 3
leaves sign-in, finding the Transactions page and reading its table to the
agent: nothing tells it which links to click. It should store Origin Energy
and −$140.00, the largest debit among the five rows. Step 4 checks the stored
pair against the page; the values themselves are checked by whoever reads the
report, since no ordinary step compares two strings.

## Config
- baseUrl: http://localhost:8787/
- agentMaxTurns: 15

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. [use agent] Sign in with the username {{username}} and the password
   {{password}}, open the list of transactions, and find the debit with the
   largest amount. Store its merchant name in largest_merchant and its amount,
   as the page shows it, in largest_amount.
4. Verify the transaction from {{largest_merchant}} shows the amount {{largest_amount}}
