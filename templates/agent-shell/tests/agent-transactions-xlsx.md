---
tags: [live-integration, agent]
---

# [use agent] live test: transactions to Excel

Fixture for a live `[use agent]` run with files and commands on
(docs/specs/SPEC-use-agent.md §6). It lives in its own project because
`agent.shell` is a project setting that a test cannot turn on, and the other
fixtures must keep it off.

Steps 1 to 6 sign in and open the Transactions page as ordinary steps. Step 7
leaves the workbook to the agent: it must read the table from the page, find a
way to write an .xlsx with what this machine has (a library it installs, or
something it writes itself), and say where the file is. Steps 8 to 10 open
the workbook with the `read_xlsx` fixture tool rather than taking the agent's
word: a header row and five transactions, the Origin Energy row among them.

## Config
- baseUrl: http://localhost:8787/
- agentMaxTurns: 20

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Click the "Transactions" link in the sidebar
7. [use agent] Write the transactions in the table on this page to an Excel
   workbook named transactions.xlsx: a header row Merchant, Date, Amount, then
   one row per transaction, each amount written as the page shows it. Store
   the workbook's full path in transactions_xlsx.
8. [tool: read_xlsx path="{{transactions_xlsx}}" header="Merchant,Date,Amount"]
9. Verify that {{xlsx_row_count}} is 6
10. Verify that {{xlsx_rows}} has a row for Origin Energy dated 22 Mar 2026 with the amount −$140.00
