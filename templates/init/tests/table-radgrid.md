---
tags: [table-read]
timeout: 900s
---

# Table read — a Telerik RadGrid: three tables, a banded header, a pager

The §5.7 case of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md),
against `fixtures/test-app/radgrid.html`, which was walked from the live
ASP.NET AJAX demo. Where Kendo's scrollable grid is two tables (§5.6,
`table-split-grids.md`), RadGrid with static headers is THREE inside one box —
a header table, the table holding the rows, and a pager table — and none of
them is the grid. Measured on the live demo before this phase, all three ways
in failed: the box was refused "found 3 tables with rows" (the header table's
hidden spacer row and the pager's one row were counted as rows), the data
table read by POSITION only (its own hidden, empty `<thead>` won over the
header its `aria-owns` names), and the header table was refused as merged.

Three grids are read here:

- **Loan applications** (`#RadGrid1`) — the three-table form. Its header has
  THREE rows: a band row (`APPLICANT`, `LOAN`, `REVIEW`) over groups of
  columns, the row of column names, and a filter row of inputs and selects.
  §7.3b lays them out as one header grid: the expand column's `<th>` spans
  both heading rows, so the name row has eight cells for a nine-column grid;
  a band names no column, and a filter cell — whose `<select>` renders the
  word "All" — names nothing either. The read names **Applicant, Amount and
  Status**, which are leaves, never `LOAN`.
- **Direct debit mandates** (`#RadGrid2`) — the non-scrolling form: ONE table
  with the same three header rows in its `<thead>` and the pager in a
  `<tfoot>`, so it reads with no pairing at all and the footer is excluded as
  a footer always is. It also carries an `aria-owns` naming its OWN `<thead>`
  and `<tbody>`, which declares nothing.
- **Quarterly fees** (`#banded-table`) — `Account | Q1 > Fee | Q1 > Rebate |
  Q2 > Fee | Q2 > Rebate`. The leaf name `Fee` appears under two bands, so the
  plain name is ambiguous and is refused with both positions; the author
  writes `the "Q1 > Fee" column as q1_fee` and the runtime walks the bands
  over that column (§7.3b.4).

Two rows on page 1 are both **Sarah Mitchell**, with different amounts. That
is what the loop over `{{applications}}` is for: each pass clicks Review in
`row {{application._row}}` and checks the banner names that applicant, so a
pass that acted on the other Sarah Mitchell fails rather than passing on a
name that matches either row.

**Requires phase 1 of the spec.** What the proving run must show, beyond
green: the run log records which selector the model chose for each read — the
box `#RadGrid1` or the data table `#RadGrid1_ctl00` — and either must come out
with the same ten records, because the runtime pairs the halves whichever it
was handed and refuses the header table outright; the summary line beside the
two Loan applications reads says `(header from a separate table)`, and the one
beside the Direct debit mandates read does not. And **no selector anywhere in
the run may be built from a row number**: RadGrid's row ids are
`RadGrid1_ctl00__0`, `__1`, … from ZERO and are renumbered on every page, so
`#RadGrid1_ctl00__{{application._row}}` would act on the row below the one the
record came from and pass green — which is exactly what the first live run of
this test did on pass 7, clicking Grace Abernathy for Kwame Boateng's record.
Each read now leaves its own numbering on the page: every data row of the
table it read carries `data-steptix-row="N"`, so `row {{application._row}}` is
`[data-steptix-row="7"]` inside the grid and there is no arithmetic to get wrong.
A `${application._row}` — the wrong braces — is refused before the action runs
(§6.3), which is the other half of the same measurement.

The expand step is there for what it does to the table: RadGrid inserts a
detail row, with no class and no id, right after the row expanded — two cells,
one of them spanning the other eight around a whole table of its own. That is
a **detail row**, not data, and it is §7.4's detail-row rule that skips it,
not §4.8's placeholder rule: two cells for a nine-column grid is seven short
of the width and the spans cover it. It takes no `_row`, its nested table is
not read, and the second read must return the same ten records with the same
numbers as the first.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to radgrid.html
2. Read the Applicant column as applicant, Amount column as amount, and Status column as status from every row in the Loan applications grid [store as: applications]
3. For each {{application}} in {{applications}}, Check the application
4. Click Expand in row 1 of the Loan applications grid
5. Read the Applicant column as applicant, Amount column as amount, and Status column as status from every row in the Loan applications grid [store as: applications_expanded]
6. For each {{expanded}} in {{applications_expanded}}, Check the expanded application
7. Set the Status filter to Declined
8. Read the Applicant column as applicant, Amount column as amount, and Status column as status from every row in the Loan applications grid [store as: declined]
9. Verify the Loan applications grid has a row for "Priya Raghunathan"
10. For each {{d}} in {{declined}}, Verify the Loan applications grid has a row for "{{d.applicant}}" showing Declined
11. Read the Payee column as payee, Amount column as amount, and Status column as status from every row in the Direct debit mandates grid [store as: mandates]
12. For each {{m}} in {{mandates}}, Verify the Direct debit mandates grid has a row for "{{m.payee}}" showing {{m.amount}}
13. Read the Account column as account and the "Q1 > Fee" column as q1_fee from every row in the Quarterly fees table [store as: fees]
14. For each {{f}} in {{fees}}, Verify the Quarterly fees table has a row for "{{f.account}}" whose Q1 fee is {{f.q1_fee}}

### Check the application
1. Verify row {{application._row}} of the Loan applications grid is "{{application.applicant}}" with amount {{application.amount}}
2. Click Review in row {{application._row}} of the Loan applications grid
3. Verify the page shows "Review opened for {{application.applicant}}."

### Check the expanded application
1. Verify row {{expanded._row}} of the Loan applications grid is "{{expanded.applicant}}" with amount {{expanded.amount}}
