---
tags: [table-read]
timeout: 600s
---

# Table read — the structures a read must take in its stride

Four tables from `fixtures/test-app/table-edge-cases.html` that
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
says read normally, each with the thing that would trip a naive reader:

- **Accounts by group** — two `<tbody>` elements, each opened by a
  full-width group row (`<th colspan="4">Everyday accounts</th>`). Group rows
  are placeholders under §4.8, so they are skipped, the group names are in
  no record, and `_row` counts the four data rows 1 to 4 straight through.
- **Direct debits** — no `<thead>`; the header is the first row of the
  `<tbody>`, made of `<th>` cells. §7.3 accepts it as the header row.
- **Payments due** — a `<tfoot>` Total row. §7.4 excludes it; the total is
  read separately.
- **Scheduled payments summary** — no header at all. Columns by position
  (§4.4); a header name against it must fail with the §5.4 message.

**Requires phase 1 of the spec.** The tables that must be *refused* (merged
headers, rowspan, duplicate headers) and the div grid are covered by the
unit tests of §12, since a passing test cannot show a refusal.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to table-edge-cases.html
2. Read the Account column as account and Balance column as balance from every row in the Accounts by group table [store as: accounts]
3. Assert that {{accounts}} contains "Term Deposit"
4. Assert that {{accounts}} does not contain "Everyday accounts"
5. Assert that {{accounts}} does not contain "Savings accounts"
6. For each {{account}} in {{accounts}}, Check the account
7. Read the Date column as date and Amount column as amount from every row in the Direct debits table [store as: debits]
8. Assert that {{debits}} contains "Telstra"
9. Assert that {{debits}} does not contain "Description"
10. Read the Payee column as payee and Amount column as amount from every row in the Payments due table [store as: due]
11. Assert that {{due}} does not contain "Total"
12. Assert that {{due}} does not contain "$481.74"
13. Read the Total in the footer of the Payments due table [store as: due_total]
14. Assert that {{due_total}} equals "$481.74"
15. Read the 1st column as payee and the 4th column as status from every row in the Scheduled payments summary table [store as: summary]
16. Assert that {{summary}} contains "Paused"
17. For each {{item}} in {{summary}}, Verify row {{item._row}} of the Scheduled payments summary table is for "{{item.payee}}" with status "{{item.status}}"

### Check the account
1. Verify the Accounts by group table has a row for "{{account.account}}" with balance {{account.balance}}
