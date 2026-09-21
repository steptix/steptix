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

**Requires phase 1 of the spec.** Each read is proved by looping over what it
returned and checking every record against the page: a group row or a footer
row that leaked into the records would fail its pass, because the page has
no data row for it. The exact record lists (and the refusals — merged
headers, rowspan, duplicate headers, the div grid) are pinned in
`tests/read-table.test.ts`, where they are deterministic. A step like
`Assert that {{accounts}} contains "Term Deposit"` is deliberately not used:
it is a model-evaluated assertion over a long JSON literal, and phase 2's
list assertions (§7.7) are the deterministic form of that check.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to table-edge-cases.html
2. Read the Account column as account and Balance column as balance from every row in the Accounts by group table [store as: accounts]
3. For each {{account}} in {{accounts}}, Check the account
4. Read the Date column as date, Description column as description and Amount column as amount from every row in the Direct debits table [store as: debits]
5. For each {{debit}} in {{debits}}, Check the direct debit
6. Read the Payee column as payee and Amount column as amount from every row in the Payments due table [store as: due]
7. For each {{payment}} in {{due}}, Check the payment due
8. Read the Total in the footer of the Payments due table [store as: due_total]
9. Assert that {{due_total}} equals "$481.74"
10. Read the 1st column as payee and the 4th column as status from every row in the Scheduled payments summary table [store as: summary]
11. For each {{item}} in {{summary}}, Verify row {{item._row}} of the Scheduled payments summary table is for "{{item.payee}}" with status "{{item.status}}"

### Check the account
1. Verify the Accounts by group table has a data row for "{{account.account}}" with balance {{account.balance}}
2. Verify "{{account.account}}" is an account name in that table, not one of its group headings

### Check the direct debit
1. Verify the Direct debits table has a row for "{{debit.description}}"
2. Verify the amount shown for "{{debit.description}}" in the Direct debits table is {{debit.amount}}
3. Verify the date shown for "{{debit.description}}" in the Direct debits table is {{debit.date}}

### Check the payment due
1. Verify the Payments due table has a body row for "{{payment.payee}}" with amount {{payment.amount}}
2. Verify "{{payment.payee}}" is a payee in that table, not its footer Total row
