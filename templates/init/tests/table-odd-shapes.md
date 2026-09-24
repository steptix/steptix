---
tags: [table-read]
timeout: 900s
---

# Table read — four shapes structure cannot decide, and the one question each costs

The §5.9 / §7.10 case of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md),
against `fixtures/test-app/odd-tables.html`. Everything else in the table-read
suite is decided by structure alone and costs no model call at all. These four
cannot be, and each is read here by asking the model ONE question about the
region's layout, validating the answer against the page, and then reading
deterministically for the rest of the run.

The four:

- **`#legacy-payees`** — headings written as `<td><b>Payee</b></td>` in the
  first body row. No `<thead>`, not one `<th>`. §7.3 finds no header, so a read
  that names *Payee* fails for a shape reason; promoting the first row on sight
  would instead eat a record from every genuinely headerless table in the app.
  The answer is `{"kind":"table","rows":"T1","header":{"table":"T1","row":1}}`
  — row 1 of this same table names the columns — and the read returns **5
  payees**.
- **`#late-header`** — the rows first, in a table with no header of its own,
  then a *Column key* paragraph, then a table of nothing but a `<thead>`.
  §7.3a pairs a header-only table with the rows when it comes FIRST and the two
  are contiguous; here neither holds, so nothing pairs and the read refuses.
  The answer pairs them across the paragraph, and the read returns **4
  accounts**.
- **`#account-cards`** — six repeated `div.account-card`, each an `<h3>` and a
  `<dl>` of label/value pairs. There is no table, no role, no row and no cell:
  not a table read badly, but nothing for a table rule to fail on. The answer
  is a **collection** — one selector for the repeated element and one per
  requested column, relative to the item. The last card is hidden, so a correct
  read returns **5 records** from 6 matching elements, with `_row` running 1…5
  and no gap for the hidden one.
- **`#property-tables`** — four payments, each its own two-column sheet with
  the field name in a `<th scope="row">`. These tables are not unreadable; they
  are readable and give the wrong answer — read one and you get the record on
  its side, name the wrapper and §7.2 refuses four tables with rows. The answer
  is a collection whose ITEM is a table and whose fields are its rows, and the
  read returns **4 records**.

Then the remembering. Step 14 reads `#legacy-payees` **again**, with the same
columns, in the same run. What answers it is the run's **structure memo**:
keyed by the region and the columns asked of it, not by the step, so any later
step reading the same thing applies the same mapping. The run log shows step 14
writing

```
readTable: structure reused from step 2
```

and no question. It is applied, not assumed — the extractor validates it
against the live page like any other mapping, so a page that changed between
the two steps falls back to asking rather than reading the wrong table. The memo
lives for one run only, so the next run of this file asks its four questions
again. One question per structure per run.

**Requires phase 1 of the spec.** What the proving run must show, beyond
green, on every run: **exactly four**
`readTable: structure asked of the model — …` lines in the whole run, one per
shape, each with a `readTable structure sketch` and a
`readTable structure answer` beside it at debug level and a summary line
naming where the structure came from; and for the **repeat read in step 14,
none of those three lines** — `readTable: structure reused from step 2`
instead, and the record counts above for free. The four sketches are also
where to check §7.6: nothing in them is a secret, but the masking that would
hide one runs on them the same way it runs on the DOM snapshot beside them.

Set `tableStructure: strict` in the `## Config` block below and this test
fails at step 2 with the shape refusal instead, which is the other half of
§7.10's "Cost and control" and the setting a run that must spend no unplanned
model call uses.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to odd-tables.html
2. Read the Payee column as payee and the Amount column as amount from every row in the Payees table in the Legacy payees section [store as: payees]
3. Verify the Payees table in the Legacy payees section shows 5 payees
4. For each {{p}} in {{payees}}, Check the payee
5. Read the Account column as account and the Balance column as balance from every row in the Account summary table [store as: late]
6. Verify the Account summary table shows 4 accounts
7. For each {{l}} in {{late}}, Check the account
8. Read the Account column as account, Balance column as balance, and Owner column as owner from every account card [store as: cards]
9. Verify the page shows 5 account cards
10. For each {{c}} in {{cards}}, Check the card
11. Read the Payee column as payee and the Amount column as amount from every property sheet table [store as: props]
12. Verify the page shows 4 payment property sheets
13. For each {{pr}} in {{props}}, Check the property sheet
14. Read the Payee column as payee and the Amount column as amount from every row in the Payees table in the Legacy payees section [store as: payees_again]
15. For each {{pa}} in {{payees_again}}, Check the repeated payee

### Check the payee
1. Verify the Payees table in the Legacy payees section has a row for "{{p.payee}}" showing {{p.amount}}

### Check the account
1. Verify the Account summary table has a row for "{{l.account}}" showing {{l.balance}}

### Check the card
1. Verify the account card for "{{c.account}}" shows a balance of {{c.balance}} owned by {{c.owner}}

### Check the property sheet
1. Verify a payment property sheet shows "{{pr.payee}}" with an amount of {{pr.amount}}

### Check the repeated payee
1. Verify the Payees table in the Legacy payees section has a row for "{{pa.payee}}" showing {{pa.amount}}
