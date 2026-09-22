# Structured table reads and object-aware `For each`

**Status:** Proposed — amended 2026-09-20 after review (§14 lists what moved out), and again 2026-09-21 once the fixtures were built, the baselines run and the acceptance tests written (§11, §12)  
**Date:** 2026-09-20  
**Audience:** implementation agent working in this repository  
**Depends on:** existing `read` actions, captured variables, sections, and the
`For each {{item}} in {{list}}, <tail>` control-flow form

---

## 1. Summary

An author can currently read one value from every matching element and store a
JSON string array:

```markdown
1. Read the order ID from every row in the Orders table [store as: order_ids]
2. For each {{order_id}} in {{order_ids}}, Check the order
```

That works when one value identifies a row. It does not safely extract several
columns. Three separate plural reads create three parallel arrays which can
silently lose row alignment when a cell is missing, hidden, or matched by a
different selector. Assuming the first cell identifies the row is also wrong
for the common case where the first column is a selection checkbox.

This feature adds two orthogonal capabilities:

1. A deterministic `readTable` AI action that reads named columns — by header
   text, or by position when the table has no header — from every visible data
   row or the first N of them, and stores one object per row. Every object
   carries the row's position as `_row`.
2. Object-aware `For each`, so a row bound as `{{order}}` exposes direct
   properties such as `{{order.id}}`, `{{order.status}}` and `{{order._row}}`.

There is deliberately no new “table loop” syntax. `For each` remains the one
list loop, and structured records can later come from APIs or tools as well as
HTML tables.

The intended flow is:

```text
native HTML table
  -> readTable action
  -> JSON array of row records in the string-valued variable map
  -> existing For each planner
  -> base binding {{order}} plus property bindings {{order.id}}, {{order._row}}, etc.
  -> ordinary steps which re-find an interactive row by a stable value or by
     its row number
```

The runtime must never keep a DOM element handle between steps or iterations.
Modern applications rerender rows, which makes such handles stale. Extraction
is a snapshot; later page actions locate the row again using a value such as an
order ID, or the row number the snapshot recorded as `_row` (§4.5).

### 1.1 Current code facts the implementation starts from

- `src/ai/types.ts` has no `readTable` action or structured-column fields.
- `src/ai/action-parser.ts` whitelists action names and copies known fields, so
  an invented `readTable` action cannot execute and an unknown `columns` field
  would be discarded.
- `read` with `multiple: true` in `src/browser/actions.ts` returns `string[]`,
  capped at 500 matches.
- `src/runner/step-executor.ts` JSON-encodes that string array into the existing
  `Record<string, string>` variable map.
- `parseListValue` already accepts any JSON array, but currently converts each
  non-string element to one JSON string. It does not expose object properties.
- Runtime placeholders use the flat `{{name}}` / `\w+` grammar in several
  deliberately mirrored modules.
- All run loops already apply `ControlPlan.pass.bindings` to their live variable
  map, so object support belongs in the shared planner/runtime binding shape,
  not as separate CLI/server/TestBench implementations.

### 1.2 Why v1 uses `readTable`, not a generic `readCollection`

A future collection reader could extract records from cards, lists, or repeated
panels. It would also require the model to invent an item selector and one
relative selector per field—the same independent-selector problem this feature
is meant to eliminate. A constrained table action lets the model name visible
headers while deterministic runtime code owns alignment. Object-aware
`For each` is generic now; additional structured-data adapters can be added
later without changing its contract.

§7.10 does ask for exactly that item selector and those field selectors — but
once, as a separate question about STRUCTURE, validated against the live page
before a cell is read, and then cached, so the selectors are chosen once and
the reading stays deterministic on this run and every run after. What the
argument above is against is a model inventing one selector per field on every
read, per row, with nothing checking that they line up; asking once, checking
the answer, and never asking again is the opposite of that.

### 1.3 Phases

The feature ships in three slices, each its own PR with its own live proof,
and each useful on its own. §13 marks which phase each acceptance criterion
belongs to.

1. **Runtime.** `readTable` (header or positional columns, `_row`, the
   placeholder-row rule, text values), records in the variable map, dotted
   `{{item.property}}` bindings, the prompt rules, and a fixture page with a
   template test and a live test. This alone makes a loop over a real table
   work end to end, duplicate rows and empty cells included.
2. **Reading more than text, and checking the whole table.** Per-column
   extraction modes (`checked`, `value`, `attribute`; §7.4) and the
   whole-table assertions of §4.9 / §7.7.
3. **Code-behind and editor.** `tables.read` in generated code-behind (§9),
   and TestBench completion, hover and go-to-definition for dotted bindings
   (§8.4).

Everything §14 lists is outside all three.

---

## 2. Goals

- Read two or more explicitly named columns from a native HTML `<table>` — or
  an ARIA grid (§7.9), or, through one question, any repeated structure
  (§7.10) — in one action while preserving row alignment.
- Ignore unrelated columns, including checkbox/select columns, when the author
  did not request them.
- Resolve columns by header text rather than by an AI-chosen `nth-child()`,
  and by one-based position when the table has no header row.
- Return a JSON array of flat row objects whose values are strings, each
  carrying its row number as `_row` so a later step can point at the row
  again after leaving the page.
- Treat a placeholder row (“No results”, “Loading…”) as what it is: an empty
  table stores `[]`, and a full-width row among data rows is skipped.
- Allow an author to intentionally restrict extraction to the first N visible
  data rows without encoding row positions in a CSS selector.
- Let an author check the whole table in one deterministic step — every row
  matches, no duplicates, sorted, a column adds up — instead of a prose
  assertion over a snapshot that collapses long tables, or a loop that asks
  the model N times.
- Iterate those objects with the existing `For each` grammar.
- Resolve direct property placeholders such as `{{order.status}}` in step text,
  cached actions, generated code-behind, reports, and every run surface.
- Behave the same through the CLI, Sessions API, MCP-backed test runs, Electron
  runner, and TestBench.
- Fail loudly on ambiguous or unsupported table structure instead of returning
  plausible but misaligned data.
- Preserve all existing scalar-array `For each` and `read multiple: true`
  behavior.

## 3. Non-goals for v1

- (Lifted.) ARIA grids and `<div role="table">` implementations read as
  tables since §7.9; repeated elements with no roles read through §7.10's
  collection answer. A grid whose header and rows are TWO native
  tables inside one wrapper — the shape Telerik/Kendo, DevExpress and
  Syncfusion render for a fixed header — is not this case: it is one table
  in two pieces, and §7.2/§7.3a read it as one (§5.6).
- Automatically paging, scrolling a virtual grid, or clicking “Load more.” An
  author composes the existing `While`/`Repeat` forms explicitly.
- Persisting Playwright `Locator` or DOM element handles in variables.
- Editing table cells or selecting rows as part of `readTable`. Those remain
  ordinary later steps.
- Implicitly reading every column when the author names none.
- Merged DATA cells using `rowspan` or `colspan` greater than 1. V1 rejects
  them with a diagnostic; silently guessing a logical grid is unsafe. There
  are two exceptions, both rows a grid writes rather than rows of data: the
  placeholder row of §4.8 — a single cell spanning at least the table's
  width, and at least two columns, is a message, not a grid — and the detail
  row of §7.4, the row a widget inserts under a record you expanded.
  Merged HEADER cells are not this case: a banded header (a "General info"
  cell over four column names, a blank cell spanning two header rows) is laid
  out by the HTML table algorithm and each column is named by the lowest
  heading above it (§5.3, §7.3b).
- Array indexing or arbitrary expression evaluation in placeholders. V1 adds
  one direct property segment (`{{row.property}}`), not
  `{{rows[0].property}}`, functions, or arithmetic.
- Recursively flattening nested objects. `readTable` emits flat objects.
- Any row selection other than all visible rows or the first N of them. An
  inclusive window (“rows 3 through 7”), last-N, “row N onward”, disjoint
  ranges and sampling are deferred (§14); a test that needs one row by
  position reads all rows and uses `_row`.
- Cell values other than rendered text in phase 1. Control state (`checked`,
  a select's chosen option, an input's value, an attribute) is phase 2
  (§1.3), behind an explicit per-column mode, never guessed.

---

## 4. Author-facing syntax

`readTable` is selected from natural language just like `read`, `count`, or
`click`; no bracket marker or new Markdown block is introduced.

### 4.1 Canonical form

Authors should name the table, every desired visible header, and stable field
aliases:

```markdown
1. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Check the order

### Check the order
1. Verify {{order.status}} equals "Completed"
2. Verify the Orders table has a row for "{{order.id}}" and customer "{{order.customer}}"
```

Aliases are the property names used after the read. They must match
`^[A-Za-z_][A-Za-z0-9_]*$`, be unique within the action, and must not be
`__proto__`, `prototype`, `constructor`, or the reserved `_row` (§4.5).

### 4.2 Shorthand aliases

The following is allowed:

```markdown
1. Read the Order ID, Customer, and Status columns from every row in the Orders table [store as: orders]
```

When an alias is omitted, the model must derive it mechanically from the header:

1. trim;
2. lowercase;
3. replace every run of non-ASCII letters/digits with `_`;
4. collapse repeated `_` and trim leading/trailing `_`;
5. prefix `_` when the result begins with a digit.

Thus `Order ID` becomes `order_id` and `Last updated (UTC)` becomes
`last_updated_utc`. If two requested headers normalize to the same key, the AI
must ask for aliases rather than invent suffixes.

Explicit aliases are strongly recommended whenever later steps use the fields.

### 4.3 Interacting with each row

Extraction and interaction are separate. Use a stable captured value to locate
the row again:

```markdown
## Steps
1. Read the Order ID column as id and Status column as status from every row in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Process the order

### Process the order
1. Verify {{order.status}} equals "Ready"
2. Tick the checkbox in the Orders table row whose Order ID is "{{order.id}}"
3. Click Review in the Orders table row whose Order ID is "{{order.id}}"
```

The click/tick actions are normal AI actions. `readTable` does not smuggle a row
locator into the variable map.

### 4.4 Columns by position, for tables with no header

Not every table has a header row, and a table with no `<th>` cells has nothing
for a header name to match. A column can instead be named by its one-based
position, and the alias is then the only name the column has:

```markdown
1. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
2. For each {{payment}} in {{payments}}, Review the payment

### Review the payment
1. If {{payment.status}} is "Paused", then return
2. Verify the Scheduled payments table has a row for "{{payment.payee}}" with amount {{payment.amount}}
```

“1st”, “first”, “column 1” and “the second column” all mean position; the
model emits `index` rather than `header` for that column (§6.1). Header and
position may be mixed in one action, but each column is one or the other.

When the table *has* a header, name columns by it: a header survives the
columns being reordered, a position does not. Position is for tables that give
you nothing else, and for the rare header text that cannot be matched
reliably. An explicit alias is required for a positional column — there is
no header to derive one from.

### 4.5 Row numbers: `_row`

Every record carries `_row`, the one-based position of its row among the
table's data rows in DOM order at capture time (§7.4). It is the one property
the author does not ask for, and `_row` is reserved: it cannot be an alias.

Its job is to let a step point at the row again without depending on a
value being unique. Two rows for the same payee are the ordinary case in a
payments table, and “the row for Origin Energy” is ambiguous on both passes;
“row 3” is not:

```markdown
### Review the payment
1. Click View in row {{payment._row}} of the Scheduled payments table
2. Verify the Payment details page shows "{{payment.payee}}" and {{payment.amount}}
3. Click Back to scheduled payments
```

A read also leaves its numbering on the page. Every data row of the table it
read carries `data-aiui-row="N"`, the same N as that row's record `_row`
(§7.4), so a later step finds "row 3" as the row matching
`[data-aiui-row="3"]` inside that table rather than counting rows itself or
computing an element id from the number.

A row number survives leaving the page and coming back, which a DOM handle
would not, and which is why this spec keeps no handles (§1). It is a
position, not an identity: if the body deletes or moves rows, every row below
the change has a different number from that pass on. For a table that changes
as you act on it, re-find by a value, or use `Repeat … until` so each pass
reads the page as it is now. Concretely, on the payments fixture Pay now
removes the Overdue row 4, so a loop that pays it on pass 4 finds Woolworths
at row 4 on pass 5 and nothing at row 5. The acceptance test
`table-payments-approve.md` therefore approves the Scheduled rows and leaves
Overdue to `table-baseline-pay-overdue.md`'s `Repeat`.

Two counts, one word. `_row` counts **data rows** — hidden rows and
placeholder rows excluded (§7.4) — while “row 3” in a prose step is whatever
the model counts in the snapshot, usually every `<tr>`. On a plain table the
two agree. On a table with group rows or a placeholder among the data they
do not: the Accounts-by-group gallery table has a group row before each
`<tbody>`'s data, so its data row 3 is the fifth `<tr>`. Where a table has
such rows, a body should verify by value (“the row for {{account.account}}
with balance {{account.balance}}”) rather than by `row {{account._row}}`;
`table-structures.md` does. The prompt rule in §6.3 tells the model what
`_row` counts, which is enough for the plain case and no substitute for
this one.

The pass can also name other rows relative to its own — “the row below row
{{payment._row}}” — and can compare its snapshot values with the page as it
is now: `Read the status in row 5 of the Scheduled payments table [store as:
row5_status]` then `Assert that {{row5_status}} equals {{payment.status}}`.
Indexing into the captured list (`{{payments[5].status}}`) stays out of scope
(§3): the page is the source of truth for “now”, and the snapshot is what it
was when read.

### 4.6 Bounded visible-row windows

An author may intentionally capture only the first N visible data rows. The
recommended form keeps extraction and interaction explicit:

```markdown
## Steps
1. Read the Order ID column as id from the first 10 visible rows in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
```

The first step emits `readTable` even though only one column is requested,
because the author is requesting bounded row records rather than one unbounded
flat column. The action carries `limit: 10`; the model must not encode the limit
as `:nth-child(-n+10)` or another positional selector.

“First” is evaluated after hidden and non-data rows are excluded, and the
remaining visible rows retain DOM order. If the table has fewer than ten visible
data rows, all available rows are captured and the loop completes fewer than ten
passes. If the test requires at least ten rows, the author must assert that
separately:

```markdown
1. Verify the Orders table contains at least 10 visible data rows
2. Read the Order ID column as id from the first 10 visible rows in the Orders table [store as: orders]
```

There is deliberately no DOM-bound `For the first 10 rows ...` control-line
syntax. `For each` continues to iterate captured values, and each interaction
re-finds its row from a stable captured column or from `_row`. If clicking the
whole row is not the application behavior, the author should name the control
instead, for example `Click Review in the ... row`.

The case this exists for is the smoke test: “open the first three and check
they load”. An inclusive window (“rows 3 through 7”) was in the first draft
and is deferred (§14): nothing needs it yet, and a test that wants one row by
position reads all rows and uses `_row`.

### 4.7 Pagination

Only rows currently rendered and visible are read. Pagination remains explicit:

```markdown
## Steps
1. Check the current Orders page
2. While the Next button is enabled, Go to the next Orders page and check it, up to 20 times

### Go to the next Orders page and check it
1. Click the Next button
2. Check the current Orders page

### Check the current Orders page
1. Read the Order ID column as id and Status column as status from every row in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Check one order

### Check one order
1. Verify {{order.status}} is not empty
2. Verify the Orders table has a row for "{{order.id}}"
```

This processes the initial page once, then each subsequent page after navigation.
`readTable` must not infer or operate pagination controls.

### 4.8 Empty tables, placeholder rows and loading rows

An empty `<tbody>` produces `[]`, and `For each` runs zero passes. If emptiness
is a test failure, say so separately:

```markdown
1. Verify the Orders table contains at least one data row
2. Read the Order ID column as id and Status column as status from every row in the Orders table [store as: orders]
```

This matches the existing empty-list behavior of plural reads and `For each`.

Real empty tables are rarely empty. This repository's own fixtures put a
message row in the body — `<td colspan="5">No documents uploaded yet.</td>`
in `fixtures/test-app/documents.html`, and a `colspan="4"` “Loading…” row in
`delegates.html` — and the first draft's merged-cell rule (§7.4) would have
failed both reads with “merged cells are not supported”. The rule is:

- A body row whose only cell spans **at least `max(width, 2)` columns** is a
  **placeholder row**, not data. "At least", because `colspan="99"` on a
  three-column table is the common "span all" idiom and has to count. The
  floor of 2 is the whole one-column story: an ordinary `colspan="1"` cell
  never reaches it, so a one-column table's rows are data. A one-column table
  with a lone `colspan="2"` message row is still a placeholder, though: a
  cell spanning more than its own column is a message,
  and refusing that row as a merged cell would be the same bug in the other
  direction.
- The width is the header GRID's width (§7.3b), not any one row's cell
  count — on RadGrid the name row is eight cells for a nine-wide grid — or,
  with no header, the widest body row's cell count, measured over **all**
  body rows, rendered or not. Measured
  over the rendered ones, a table whose only rendered row is the message
  (`<td colspan="7">No scheduled payments.</td>` alone in the body, or every
  data row hidden by a filter) came out one column wide, the rule never
  fired, and the read failed as a merged cell instead of storing `[]`. The
  hidden rows are the last evidence of how wide the table is.
- The same when the spanning cell is the row's only RENDERED cell and every
  other cell in the row is unrendered. Kendo's group row (§5.6) is
  `<td colspan="6">Year: 2026</td>` followed by five `<td hidden>` filler
  cells, so it has six cells and one visible one; counted as six it reached
  the merged-cell rule and failed the whole read of a grouped grid.
- A body row with no cells at all is skipped and counted the same way: there
  is nothing in it to map and nothing to number.
- If every body row is a placeholder, the table is empty: store `[]`.
- If placeholders sit among data rows, skip them. They do not get a `_row`
  number; `_row` counts data rows only.
- Any other merged cell is still an error — including `rowspan="0"`, which is
  legal HTML for "to the end of this row group". The DOM reports it as `0`,
  so a `> 1` test missed it and read the row as if it stood alone.

A loading row is a placeholder that will be replaced, so a read that lands on
it stores `[]` truthfully and the test goes wrong later. `readTable` does not
wait for data; the author does, with the wait forms that already exist:

```markdown
1. Navigate to delegates.html
2. Wait until the Delegates table has finished loading
3. Read the Name, Email and Status columns from every row in the Delegates table [store as: delegates]
```

### 4.9 Whole-table checks

Most table tests are not loops. They are one question about every row: is
every status one of three values, do two rows share a reference, is the table
sorted by date, does the Amount column add up to the total under it, did the
filter leave only matching rows. Today those are prose assertions, and on a
long table they are quietly wrong: the DOM snapshot collapses repeated rows
to a head and a tail (the `similar <tr> elements omitted` marker), so “verify
every row is Completed” checks the rows the model can see. A loop that asserts
per row is honest but asks the model N times for one comparison.

With records in hand the check is deterministic. Phase 2 (§1.3) adds a small
set of assertions over a captured list, written as ordinary steps:

```markdown
2. Read the Payee, Reference, Amount, Next payment and Status columns from every row in the Scheduled payments table [store as: payments]
3. Verify every row in {{payments}} has a status of "Scheduled", "Paused" or "Overdue"
4. Verify no two rows in {{payments}} share a reference
5. Verify the rows in {{payments}} are sorted by next payment, earliest first
6. Verify the amount values in {{payments}} add up to "$1,234.56"
```

Semantics are in §7.7. Until phase 2 lands, the same checks work today
through a tool, since tool parameters already accept arrays:
`[tool: sum_column rows="{{payments}}" column="amount" out.sum="amount_sum"]`.

Do not reach for `Assert that {{accounts}} contains "Term Deposit"` in the
meantime — nor `equals`, `does not contain`, or any other predicate over
the captured JSON. It reads as deterministic and is not: the substituted
step is a long JSON literal, the model must classify it as a self-contained
predicate, and in the phase-1 acceptance runs gpt-5.6-luna did so about
half the time and otherwise emitted a DOM assertion with no expectation,
which fails. The
acceptance tests prove the same facts by looping over the records and
checking each against the page, and pin the exact record lists in
`tests/read-table.test.ts`. A deterministic `contains` over a captured list
is the first thing §7.7 has to deliver.

---

## 5. HTML examples

### 5.1 Checkbox first column and no row data attributes

This is the primary fixture. It intentionally has no `data-order-id`; the
first column is a checkbox and the requested columns are not selected by
position in the AI action.

```html
<table id="orders" aria-label="Orders">
  <thead>
    <tr>
      <th scope="col">
        <input type="checkbox" aria-label="Select all orders">
      </th>
      <th scope="col">Order ID</th>
      <th scope="col">Customer</th>
      <th scope="col">Total</th>
      <th scope="col">Status</th>
      <th scope="col">Actions</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><input type="checkbox" aria-label="Select order ORD-1001"></td>
      <td><a href="/orders/ORD-1001">ORD-1001</a></td>
      <td>Alice Smith</td>
      <td>$125.00</td>
      <td><span class="status status-complete">Completed</span></td>
      <td><button type="button">Review</button></td>
    </tr>
    <tr>
      <td><input type="checkbox" aria-label="Select order ORD-1002"></td>
      <td><a href="/orders/ORD-1002">ORD-1002</a></td>
      <td>Bob Jones</td>
      <td>$89.50</td>
      <td><span class="status status-pending">Pending</span></td>
      <td><button type="button">Review</button></td>
    </tr>
  </tbody>
</table>
```

The canonical author step:

```markdown
1. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders]
```

Expected stored value:

```json
[
  { "_row": "1", "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" },
  { "_row": "2", "id": "ORD-1002", "customer": "Bob Jones", "status": "Pending" }
]
```

The checkbox, Total, and Actions columns are not present because the author did
not request them. `_row` is present because every record carries it (§4.5).

### 5.2 Columns reordered

The runtime must still read the correct values after a UI release reorders the
columns:

```html
<table aria-label="Orders">
  <thead>
    <tr>
      <th scope="col">Status</th>
      <th scope="col">Customer</th>
      <th scope="col">Order ID</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Completed</td>
      <td>Alice Smith</td>
      <td>ORD-1001</td>
    </tr>
  </tbody>
</table>
```

The same action still yields:

```json
[{ "_row": "1", "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" }]
```

### 5.3 Banded header

A header of more than one row, with cells spanning columns and rows — the
shape every grid widget renders for column groups, and what RadGrid calls a
multi-header (§5.7):

```html
<table aria-label="Orders">
  <thead>
    <tr>
      <th colspan="2">Order</th>
      <th rowspan="2">Status</th>
    </tr>
    <tr>
      <th>ID</th>
      <th>Customer</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>ORD-1001</td><td>Alice Smith</td><td>Completed</td></tr>
  </tbody>
</table>
```

The header grid (§7.3b) is three columns wide. Column 1 is named `ID`, column
2 `Customer` and column 3 `Status` — the lowest heading over each column.
`Order` is a **band** over columns 1 and 2, not a column:

```text
Read the ID column as id, Customer column as customer, and Status column as status from every row in the Orders table
→ [{ "_row": "1", "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" }]
```

A request for the band fails, and says what it is:

```text
readTable cannot map table "Orders": no column is headed "Order" — available headers are ID, Customer, Status ("Order" is a band over ID, Customer, not a column)
```

The available-headers list is what the page RENDERED, not what the markup
says: the fixture app's stylesheet sets `text-transform: uppercase` on
`<th>`, so on the real page — and in the test that pins this sentence — it
reads `ID, CUSTOMER, STATUS`. Matching is case-folded (§7.3), so the author
still writes `Status`.

When leaf names repeat under different bands — `Q1 > Fee` and `Q2 > Fee` on
the Quarterly fees table of `radgrid.html` — the plain name is ambiguous and
lists the positions, as any duplicate does (§7.3); the author names the band
with the leaf, `the "Q1 > Fee" column as q1_fee`, and the match walks the
bands over that column from the top (§7.3b).

Merged cells in the BODY are still the §7.4 error — the header algorithm is
well defined by the HTML specification, and a body cell spanning two columns
is not.

### 5.4 No header row, and a duplicate payee

The second fixture, built as `fixtures/test-app/scheduled-payments.html`
(five rows there; the first three shown here). No `<thead>`, no `<th>`, two
rows for the same payee, cells that are empty on some rows and not others,
and seven columns: columns 1 to 5 are the data every step in this document
reads, an Auto-pay checkbox is column 6 (there for the phase-2 `checked`
mode) and the row's buttons are column 7.

```html
<table id="scheduled-payments" aria-label="Scheduled payments">
  <tbody>
    <tr data-id="1">
      <td>Origin Energy</td><td>INV-2291</td><td>$140.00</td><td>3 Oct 2026</td><td>Scheduled</td>
      <td><input type="checkbox" aria-label="Auto-pay for Origin Energy" checked></td>
      <td><button type="button">View</button> <button type="button">Approve</button> <button type="button">Skip</button></td>
    </tr>
    <tr data-id="2">
      <td>Netflix Australia</td><td></td><td>$22.99</td><td>1 Oct 2026</td><td>Scheduled</td>
      <td><input type="checkbox" aria-label="Auto-pay for Netflix Australia" checked></td>
      <td><button type="button">View</button> <button type="button">Approve</button> <button type="button">Skip</button></td>
    </tr>
    <tr data-id="3">
      <td>Origin Energy</td><td></td><td>$86.10</td><td></td><td>Paused</td>
      <td><input type="checkbox" aria-label="Auto-pay for Origin Energy"></td>
      <td><button type="button">View</button> <button type="button">Resume</button></td>
    </tr>
  </tbody>
</table>
```

`data-id` is the page's own stable key and is not the row's position; a read
never sees it, which is the point — `_row` is what the read gives a body to
find the row by.

The author step:

```markdown
1. Read the 1st column as payee, the 2nd column as reference, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
```

Expected stored value:

```json
[
  { "_row": "1", "payee": "Origin Energy", "reference": "INV-2291", "amount": "$140.00", "status": "Scheduled" },
  { "_row": "2", "payee": "Netflix Australia", "reference": "", "amount": "$22.99", "status": "Scheduled" },
  { "_row": "3", "payee": "Origin Energy", "reference": "", "amount": "$86.10", "status": "Paused" }
]
```

A header-named column against this table fails:

```text
readTable cannot map table "Scheduled payments": it has no header row, so "Payee" cannot be matched — name columns by position ("the 1st column as payee")
```

### 5.5 Placeholder row

`fixtures/test-app/documents.html`, after “Clear all”:

```html
<table id="documents-table">
  <thead><tr><th>Name</th><th>Size</th><th>Type</th><th>SHA-256</th><th>Uploaded</th></tr></thead>
  <tbody>
    <tr id="documents-empty"><td class="doc-empty" colspan="5">No documents uploaded yet.</td></tr>
  </tbody>
</table>
```

`Read the Name and Size columns from every row in the Uploaded documents table`
stores `[]` (§4.8). The same row among real rows would be skipped, and a
`colspan="3"` cell in a five-column table is still the §7.4 merged-cell error.

### 5.6 Header and rows in separate tables

`fixtures/test-app/split-grids.html`, the Holdings grid — the markup Kendo UI
renders for a scrollable grid, copied from the live Telerik demo. The header
is one `<table>`, the rows are a second `<table>`, and a footer is a third;
the app's own id is on the wrapper `<div>`, and the row table's `id` is a
generated GUID (the fixture spells it `holdings-table`):

```html
<div id="holdings-grid" class="k-grid" data-role="grid">
  <div class="k-grid-header">
    <div class="k-grid-header-wrap">
      <table role="none" class="k-grid-header-table k-table">
        <thead class="k-table-thead" role="rowgroup" id="holdings-thead">
          <tr class="k-table-row" role="row">
            <th scope="col" class="k-table-th k-header" role="columnheader"><input type="checkbox" aria-label="Select all rows"></th>
            <th scope="col" class="k-table-th k-header" role="columnheader" data-field="symbol" data-title="Symbol" rowspan="1">
              <span class="k-cell-inner"><span class="k-link"><span class="k-column-title">Symbol</span></span>
              <a class="k-grid-column-menu" href="#" aria-hidden="true" title="Symbol edit column settings"><span class="k-icon" aria-hidden="true"></span></a></span>
            </th>
            <th …>Name</th> <th …>Units</th> <th …>Price</th> <th …>Value</th> <th …>Change</th> <th …>Actions</th>
          </tr>
        </thead>
      </table>
    </div>
  </div>
  <div class="k-grid-container">
    <div class="k-grid-content">
      <table class="k-grid-table k-table" role="grid" aria-rowcount="-1"
             aria-owns="holdings-thead holdings-tbody">
        <tbody class="k-table-tbody" role="rowgroup" id="holdings-tbody">
          <tr class="k-table-row k-master-row" role="row"><td class="k-table-td" role="gridcell"><input type="checkbox" aria-label="Select row"></td><td …>VAS</td><td …>Vanguard Australian Shares</td><td …>120</td><td …>$95.10</td><td …>$11,412.00</td><td …>+1.2%</td><td …><button type="button">Sell</button></td></tr>
          …
        </tbody>
      </table>
    </div>
  </div>
  <div class="k-grid-footer"><div class="k-grid-footer-wrap">
    <table class="k-table k-grid-footer-table" role="none"><tfoot><tr><td></td><td>Total</td><td></td><td></td><td></td><td>$67,961.00</td><td></td><td></td></tr></tfoot></table>
  </div></div>
</div>
```

`Read the Symbol column as symbol, Name column as name, and Value column as value from every row in the Holdings grid`
is one `readTable` whose `selector` is the wrapper, `#holdings-grid`:

```json
{
  "action": "readTable",
  "selector": "#holdings-grid",
  "columns": [
    { "header": "Symbol", "key": "symbol" },
    { "header": "Name", "key": "name" },
    { "header": "Value", "key": "value" }
  ],
  "as": "holdings",
  "description": "Read symbol, name and value from every Holdings row"
}
```

The runtime finds the one table under the wrapper that has rows, takes the
header from the table that has only a header (§7.2), and the records are the
six rows, `_row` first, exactly as they would be from one table. The same
read with `selector: "#holdings-grid .k-grid-content table"` — the row
table itself — gives the same records: that table names its header through
`aria-owns`, and a table that does not is paired with the header-only table
beside it (§7.3a). The one selector that does NOT work is the header table:
it has no rows, and rather than storing `[]` the read fails and names the
wrapper (§7.3a, "the header-only pick").

The Dividends grid on the same page is the grouped form, with a group row
`<td colspan="6">Year: 2026</td>` followed by five `<td hidden>` filler
cells (§4.8) and no `aria-owns`; the Watchlist grid is the same split under
DevExpress class names with a hidden column; and the Frozen holdings grid is
Kendo's locked-columns form — FOUR tables, the rows split by column across
two of them — which the read refuses by name through the wrapper, the header
tables and the locked half, rather than reading half of it as the whole
(§7.3a says what each of the four tables gives).

### 5.7 Telerik RadGrid: three tables, a banded header with a filter row, and a pager

`fixtures/test-app/radgrid.html`, the Loan applications grid — the markup
Telerik's RadGrid (ASP.NET AJAX) renders with static headers, walked from the
live demo. Three tables inside the box, none of them the whole grid:

```html
<div id="RadGrid1" class="RadGrid RadGrid_Silk rgMultiHeader">
  <div class="rgHeaderWrapper"><div class="rgHeaderDiv">
    <table id="RadGrid1_ctl00_Header" class="rgMasterTable" role="presentation">
      <thead id="RadGrid1_ctl00_Header_thead">
        <tr class="rgMultiHeaderRow"><th rowspan="2"></th><th colspan="2">APPLICANT</th><th colspan="3">LOAN</th><th colspan="3">REVIEW</th></tr>
        <tr class="rgMultiHeaderRow"><th>Applicant</th><th>Type</th><th>Amount</th><th>Term</th><th>Rate</th><th>Status</th><th>Officer</th><th>Action</th></tr>
        <tr class="rgFilterRow"><td></td><td><input …></td><td><select …></td><td></td><td></td><td></td><td><select …></td><td></td><td></td></tr>
      </thead>
      <tbody style="display:none"><tr><td colspan="9"></td></tr></tbody>
    </table>
  </div></div>
  <div class="rgDataDiv">
    <table id="RadGrid1_ctl00" class="rgMasterTable" role="grid"
           aria-owns="RadGrid1_ctl00_Header_thead RadGrid1_ctl00_tbody">
      <thead style="display:none"><tr><th></th></tr></thead>
      <tbody id="RadGrid1_ctl00_tbody">
        <tr id="RadGrid1_ctl00__0" class="rgRow"><td class="rgExpandCol"><button type="button" class="t-button rgActionButton rgExpand"></button></td><td>Sarah Mitchell</td><td>Home</td><td>$420,000.00</td><td>30 years</td><td>5.89%</td><td><span class="badge">Approved</span></td><td>D. Nguyen</td><td><input type="button" value="Review"></td></tr>
        <tr id="RadGrid1_ctl00__1" class="rgAltRow">…</tr>
        …
      </tbody>
    </table>
  </div>
  <table id="RadGrid1_ctl00_Pager" class="rgMasterTable" role="presentation">
    <thead style="display:none"><tr></tr></thead>
    <tbody><tr class="rgPager"><td class="rgPagerCell" colspan="9"><div class="NextPrevAndNumeric">…1 2 3 … 26 applications…</div></td></tr></tbody>
  </table>
</div>
```

Everything this page needs, and why each is in the rules:

- The header has THREE rows: a band row, the column names, and a filter row
  of inputs. §7.3b lays them out: the blank first cell spans two rows, so the
  name row has eight cells for nine columns; the filter row has no headings
  and names nothing; the grid is nine wide, which is what the data rows are.
- The header table's body holds one hidden spacer row `<td colspan="9">`
  (hidden by `display:none` on the `<tbody>` itself, not the row), and the
  pager table's one row is `<td colspan="9">` around the pager's `<div>`s.
  Both are §4.8 message rows, so neither table "has rows" for §7.2, and the
  box reads: one table with data rows.
- Expanding a row inserts, right after it, a row with no class and no id:
  `<tr role="row"><td class="rgExpandCol"></td><td colspan="8">…</td></tr>`,
  the detail template inside the wide cell with a nested table of its own.
  Two cells for nine columns, one of them spanning: §7.4's detail-row rule
  skips it and counts it, and the nested table's rows are not read. Kendo's
  detail row has the same two-cell shape. Measured before the rule: a read
  after one expand failed as a short row.
- The expand column's `<th>` holds `<span style="display:none">ExpandColumn</span>`:
  `innerText` is blank, `textContent` is `ExpandColumn`, so §7.3's
  visually-hidden fallback names column 1 `ExpandColumn`. Harmless — nobody
  requests it — and it is what the available-headers list shows.
- The `aria-owns` value carries a trailing space, as RadGrid emits it; and
  the non-scrolling form (`#RadGrid2`) carries an `aria-owns` naming its OWN
  `<thead>` and `<tbody>`, which is not a declaration of another table's
  header and is ignored (§7.3a.1: the owned element must sit in a different
  table).
- The band over columns 2–3 is `APPLICANT` and column 2's own heading is
  `APPLICANT`: a request for "Applicant" matches the LEAF; bands are
  consulted only when no leaf matches (§7.3b).
- The data table carries a `<thead>` of its own, hidden, with one empty
  `<th>`. It yields no heading, so it is no header (§7.3b), and the
  `aria-owns` it also carries names the real one (§7.3a.1).
- Row ids are `RadGrid1_ctl00__0`, `__1`, … — ZERO-based, and renumbered from
  `__0` on every page. `_row` is one-based. §6.3 tells the model never to
  build an element id from a row number.

`Read the Applicant column as applicant, Amount column as amount, and Status column as status from every row in the Loan applications grid`
gives ten records from page 1 whichever the model names: the box
(`#RadGrid1`), the data table (`#RadGrid1_ctl00`, header through
`aria-owns`), and the header table is refused naming the box (§7.3a.3). The
non-scrolling RadGrid on the same page (`#RadGrid2`) is ONE table with the
same three header rows in its `<thead>` and the pager in `<tfoot>`, and reads
with no pairing at all.

### 5.8 A grid with no `<table>` in it: MUI DataGrid, ag-Grid

`fixtures/test-app/aria-grid.html`. The MUI DataGrid shape, measured on
https://mui.com/x/react-data-grid/ (2026-09-23): a `div[role="grid"]` with
`aria-rowcount` and `aria-colcount`, rows as `div[role="row"]` carrying
`aria-rowindex` (the header row is 1), header cells `role="columnheader"`
and data cells `role="gridcell"`, each with `aria-colindex`, and a
`role="none"` filler cell first in every row:

```html
<div role="grid" aria-rowcount="7" aria-colcount="4" class="MuiDataGrid-main">
  <div role="presentation" class="MuiDataGrid-virtualScroller">
    <div role="row" aria-rowindex="1">
      <div role="none"></div>
      <div role="columnheader" aria-colindex="1">Account</div>
      <div role="columnheader" aria-colindex="2">Balance</div>
      <div role="columnheader" aria-colindex="3">Status</div>
    </div>
    <div role="rowgroup">
      <div role="row" aria-rowindex="2"><div role="none"></div><div role="gridcell" aria-colindex="1">Everyday</div><div role="gridcell" aria-colindex="2">$2,340.10</div><div role="gridcell" aria-colindex="3">Active</div></div>
      …
    </div>
  </div>
</div>
```

The ag-Grid shape on the same page is documentation-derived (its demo did not
render headless): `div.ag-root[role="grid"]`, header rows
`div.ag-header-row[role="row"]` of `div.ag-header-cell[role="columnheader"]`
with `aria-colindex`, data rows `div.ag-row[role="row"]` with `row-index`
and `aria-rowindex`, cells `div.ag-cell[role="gridcell"]` with
`aria-colindex` — and a pinned-left container that holds the SAME rows'
first cells again, split by column, each fragment carrying the same
`aria-rowindex`. §7.9 reads both as one table by header name, and joins the
pinned fragments by row index into one record.

### 5.9 Shapes structure cannot decide

`fixtures/test-app/odd-tables.html`, four shapes that no structural rule
reads, each common in older business applications, and each read through
§7.10 after the model names the parts once:

1. **Headings as `<td>` in the first body row.** No `<thead>`, no `<th>`:
   `<tr><td><b>Payee</b></td><td><b>Reference</b></td><td><b>Amount</b></td></tr>`
   over the data.
   §7.3 sees no header; the model says "row 1 of T1 is the header".
2. **A header table AFTER the rows**, with a paragraph between them, so the
   §7.3a contiguity rule keeps them apart. The model pairs them.
3. **A card list.** `div.account-card` repeated, each holding an
   `h3.card-title` with the account's name and a `div.fields` of
   `div.field` rows, each a `span.label`/`span.value` pair — Balance,
   Status and Owner. No rows or cells anywhere; the model answers a
   collection: the item selector and one field selector per requested column,
   the name coming from the title rather than from a label/value pair.
4. **One small key/value table per record.** Each record is its own
   two-column table (label, value), stacked. A collection whose item is the
   table and whose fields are rows by label.

---

## 6. AI action contract

### 6.1 Action shape

Add `readTable` to `ActionType` and add a table-column type:

```ts
export interface TableReadColumn {
  /** Visible header text, matched after whitespace/case normalization.
   *  Exactly one of `header` and `index` is present. */
  header?: string;
  /** One-based column position, for a table with no header row (§4.4). */
  index?: number;
  /** Property written on every output row. Never `_row` (§4.5). */
  key: string;
  /** How the cell is read. Phase 1 accepts only 'text' (the default);
   *  phase 2 adds 'checked' | 'value' | 'attribute' (§1.3, §7.4). */
  mode?: 'text';
}
```

The current bag-shaped `AIAction` gains:

```ts
columns?: TableReadColumn[];
/**
 * readTable only: capture at most this many visible data rows after visibility
 * filtering, in DOM order. Omission means all visible rows, subject to the
 * absolute 500-row safety cap.
 */
limit?: number;
```

`_row` is not a column: the runtime writes it on every record (§7.4).

`readTable` reuses these existing fields:

- `selector`: CSS selector for one native `<table>`, one ARIA grid (§7.9),
  or one element that contains a grid's header table and row table (§5.6,
  §7.2) — or, when structure cannot decide, the region the model is asked
  about (§7.10);
- `mapping`: runtime-owned (§7.10). Never emitted by the model — the parser
  strips it — written by the runtime after a validated structure answer,
  stored in the step cache and shown in the report;
- `frame`: optional existing iframe selector;
- `as`: destination variable name;
- `description`: model-authored description.

Valid model response for §5.1:

```json
{
  "actions": [
    {
      "action": "readTable",
      "selector": "table[aria-label=\"Orders\"]",
      "columns": [
        { "header": "Order ID", "key": "id" },
        { "header": "Customer", "key": "customer" },
        { "header": "Status", "key": "status" }
      ],
      "as": "orders",
      "description": "Read the requested values from every visible Orders table row"
    }
  ],
  "needs_reeval": false
}
```

Another valid response using derived aliases:

```json
{
  "actions": [
    {
      "action": "readTable",
      "selector": "#orders",
      "columns": [
        { "header": "Order ID", "key": "order_id" },
        { "header": "Last updated (UTC)", "key": "last_updated_utc" }
      ],
      "as": "orders",
      "description": "Read order IDs and update times from the Orders table"
    }
  ],
  "needs_reeval": false
}
```

Valid response for the bounded example in §4.6:

```json
{
  "actions": [
    {
      "action": "readTable",
      "selector": "table[aria-label=\"Orders\"]",
      "columns": [
        { "header": "Order ID", "key": "id" }
      ],
      "limit": 10,
      "as": "orders",
      "description": "Read IDs from the first 10 visible Orders table rows"
    }
  ],
  "needs_reeval": false
}
```

Valid response for the headerless table in §5.4:

```json
{
  "actions": [
    {
      "action": "readTable",
      "selector": "#scheduled-payments",
      "columns": [
        { "index": 1, "key": "payee" },
        { "index": 2, "key": "reference" },
        { "index": 3, "key": "amount" },
        { "index": 5, "key": "status" }
      ],
      "as": "payments",
      "description": "Read payee, reference, amount and status from every Scheduled payments row"
    }
  ],
  "needs_reeval": false
}
```

### 6.2 Parser validation

`parseAIResponse` must reject the whole `readTable` action with a precise error
when any of these holds:

- `selector` is absent or blank;
- `as` is absent or not a valid variable name;
- `columns` is absent, empty, or not an array;
- a column is not an object;
- a column has neither `header` nor `index`, or has both;
- `header`, when present, is blank;
- `index`, when present, is not an integer from 1 through 100 inclusive;
- `key` is invalid, dangerous, duplicated, or is `_row`;
- a `(header, key)` or `(index, key)` pair is duplicated;
- `mode`, when present, is not `'text'` (phase 1);
- more than 20 columns are requested;
- `limit`, when present, is not a finite integer from 1 through 500 inclusive.

Do not silently drop malformed columns and run a partial read. Partial
structured data is more dangerous than a failed step.

The parser must copy `columns` (with `index` and `mode` intact) and a validated
`limit` into the canonical action; today it only copies known scalar fields and
would discard them. `limit` is a `readTable` field, not a configurable
replacement for the existing `READ_MULTIPLE_MAX` behavior of `read` with
`multiple: true`.

### 6.3 Prompt rule

Teach the step-planning prompt:

- Use `readTable` when one step asks for two or more named columns from every
  row of a native HTML table — or of a grid that renders its header and its
  rows as two tables (below) — or explicitly asks for row records/objects.
- Also use `readTable` when the author asks for the first/up to/at most N rows,
  even if only one named column is needed; emit that positive integer as
  `limit`.
- Use existing `read` with `multiple: true` for one flat column unless the
  author explicitly requests records or a bounded table window.
- Copy header names exactly as observed in the DOM snapshot.
- When the author names a column by position (“the 1st column”, “column 3”,
  “the second column as …”), or the table in the snapshot has no header row,
  emit `index` (one-based) instead of `header`. Never emit both for one
  column, and never turn a header name into an index or an index into a
  header name: the runtime resolves each the way the author wrote it.
- Split grids (§5.6): some grid widgets (Telerik/Kendo, DevExpress,
  Syncfusion) render the header row in one `<table>` and the data rows in a
  second `<table>`, inside one wrapper element that carries the grid's id,
  `aria-label` or `role="grid"`. Treat the pair as ONE table. Put the
  WRAPPER's selector in `selector` (`#orders-grid`,
  `[aria-label="Orders"]`), or the selector of the table that holds the
  rows. NEVER select the table that holds only the header: it has no rows.
  Keep naming columns by `header`: the runtime maps the header table's
  headings onto the row table's cells. Do not switch to `index` because the
  row table shows no `<th>` — the clause above about a table with no header
  row is about a table with no header anywhere, not about one whose header
  is in the table beside it. (Rule 13d "SPLIT GRIDS" in `src/ai/prompts.ts`,
  pinned by `tests/prompts-read-table.test.ts`.) The runtime holds this
  regardless of what the model emits: the row table is paired with its
  header (§7.3a), and the header-only table is refused with a message that
  names the wrapper. RadGrid (Telerik ASP.NET AJAX) is the three-table form:
  a header table, the row table and a pager table in one box (§5.7).
- Banded headers (§5.3, §7.3b): a header of several rows names each column
  by the LOWEST heading over it. Copy that name; a band over a group of
  columns ("General info") is not a column, and a filter row of inputs names
  nothing. When the same leaf name appears under two bands, write the band
  with the leaf, `"Q1 > Fee"`. (Rule 13d "BANDED HEADERS".)
- "Row N" is the Nth DATA row of that table, counting from 1 — header,
  filter, hidden and expanded-detail rows do not count — and after any read
  of the table every data row carries `data-aiui-row="N"` (§7.4). The
  selector for "row 7" is therefore the TABLE's own selector followed by
  `[data-aiui-row="7"]` — `#RadGrid1 [data-aiui-row="7"]`,
  `table[aria-label="Orders"] [data-aiui-row="7"]` — and that scoping is
  required, not tidiness: the bare attribute matches row 7 of every table
  read in this run. NEVER compute an element id or a selector
  from the number: measured on RadGrid, ids run `RadGrid1_ctl00__0`, `__1`, …
  from zero and renumber per page, so "row 7" as `__7` reviewed the eighth
  applicant, green — the step text the model sees is already "row 7", not
  `{{item._row}}`, so the rule is about the literal form; and never
  `tr:nth-child(N)`, which counts hidden and detail rows. When no row
  carries the attribute (never read, or re-rendered since), count the data
  rows in the snapshot. (The "ROW IDS" rule, unnumbered, beside the
  placeholder rule 8a, which is where the mistake is made — in a later
  step's selector, not in the read.)
- A `${name}` whose name is a placeholder or loop binding this run knows is
  a misspelling of `{{name}}`, and the turn is refused with that correction
  even when the run has no environment (`checkTurnReferences`,
  `src/runner/placeholder-substitution.ts`). Measured: a selector of
  `#RadGrid1_ctl00__${item._row} …` reached Playwright as written, because
  `${…}` is only checked against an environment and this test had none.
- Grids with no `<table>` (§5.8, §7.9): a `div[role="grid"]`,
  `role="table"` or `role="treegrid"` reads exactly as a table; name it the
  same way and name columns by their `columnheader` text. A `treegrid`
  reads flat — every rendered row is a data row (§14).
- When the read fails for a shape reason the runtime asks the model once
  for the structure (§7.10) — that is a separate question with its own
  prompt, not something this step's plan should attempt: never answer a
  "readTable" with a hand-built set of `read` actions or `nth-child`
  selectors because the table looks unusual.
- Copy explicit author aliases exactly; otherwise apply the normalization rule
  in §4.2. A positional column has no header to derive from, so it needs an
  explicit alias; without one, return a `prompt` asking for it.
- Never request `_row`: the runtime adds it to every record. A later step may
  use `{{item._row}}` freely, as “row 3 of the … table”. When a step names a
  row by number, count **data rows**: `_row` skips hidden rows and full-width
  placeholder or group rows, so on a table with those, row 3 is the third
  row that holds data, not the third `<tr>`.
- Request only author-named columns. Never add checkbox, action, or hidden
  columns “for context.”
- Do not calculate `nth-child()` selectors for columns. The runtime maps
  headers and positions.
- Do not calculate `:nth-child(-n+N)` or similar selectors for a row bound. Use
  `limit`, and emit it only when the author explicitly requested a bound.
- `limit` addresses only the first N visible rows on the current rendered page.
  Do not use it to imply pagination, scrolling, last N, a starting row, a
  range, sorting, or an exact-row-count assertion. For any of those, return a
  `prompt` explaining the v1 restriction rather than silently changing the
  meaning.
- If the author asks for all rows but names no columns, return a `prompt` asking
  which columns are required instead of guessing.
- Refuse the phase-2 wording **by name**: reading a checkbox's ticked state, an
  input's value or an attribute is not supported yet, so a step asking for one
  returns a `prompt` rather than requesting that column as text. Naming the
  three is what stops the quiet failure — a column asked for as a tick that
  comes back as the cell's text reads as a pass over the wrong thing. (Rule
  13d "WHAT NOT TO GUESS" in `src/ai/prompts.ts`, pinned by
  `tests/prompts-read-table.test.ts`.)
- If the table is missing from the snapshot, use existing `find`/`expand`
  exploration and reevaluate rather than guessing a selector.
- Set `needs_reeval: false`; the action is observational and completes the read.

Add prompt-string regression tests so this vocabulary cannot disappear while
the TypeScript types still compile.

---

## 7. Runtime extraction semantics

### 7.1 Action result

Extend `ActionExecutionResult` with a separate structured result:

```ts
capturedRecords?: Array<Record<string, string>>;
```

Do not widen `capturedValues: string[]`; keeping flat and structured captures
distinct prevents accidental assumptions in existing consumers.

On success, `step-executor.ts` stores:

```ts
resolvedParameters[action.as] = JSON.stringify(result.capturedRecords);
```

The resolved-parameter map remains `Record<string, string>`. No protocol or
session storage migration is required.

### 7.2 Table selection

1. Resolve `frame` using the existing locator-root path.
2. Resolve `selector` and require exactly one matching visible element. Zero
   matches fail as not found; more than one fails as ambiguous. Do not call
   `.first()` for `readTable`.
3. The matched element is one of two things:
   - a native `HTMLTableElement`: the table to read. Its header is its own
     header row (§7.3) or, when it has none, one found in another table
     (§7.3a);
   - any other element: a **grid wrapper** (§5.6). Consider the RENDERED
     tables and ARIA grids (§7.9) under it that are not nested inside another
     table or grid under it, in document order. Exactly one of them must have DATA rows — body rows
     that are not §4.8 message rows, rendered or not: RadGrid's header table
     holds one hidden `<td colspan="9">` spacer and its pager table one
     `<td colspan="9">` row, and neither is data (§5.7); that is the table to
     read. When NO table under the wrapper has a data row, the read falls
     back to the tables that have any body row at all — a Kendo grid emptied
     to its `<td colspan="6">No records available.</td>` row has no data
     anywhere, and must still answer `[]` rather than "found no table with
     rows" (measured). Header-only tables (§7.3a.2) are excluded from that
     fallback, and what is left is taken in three levels: first a table with
     a **declared** header, whose `aria-owns` names another table's
     `<thead>` or `<tr>` (§7.3a.1); then a table carrying `role="grid"`;
     then everything else. The first level holding exactly one table wins;
     a level holding two or more is the frozen-columns refusal below, and no
     table at any level is `readTable found no table with rows`. Measured: a
     RadGrid box emptied to its "No records" row was refused "found 3 tables
     with rows", because the header table's hidden spacer row and the
     pager's one row are body rows — and it is the data table's `aria-owns`
     and its `role="grid"` that single it out from those two. Its header is,
     in order:
     its own header grid when it names a column (§7.3b); the header its `aria-owns` declares
     (§7.3a.1), so the wrapper and the row table give the same records
     whatever the DOM order; else the one header-only table before it under
     the wrapper (§7.3a.2 says what header-only means and applies its width
     check; its name and contiguity conditions do not apply, because naming
     the wrapper is the author asserting that the tables belong together). A
     table with neither body rows nor a header row — a footer table holding
     only a `<tfoot>` — is ignored. An ARIA grid under the wrapper is a
     candidate on the same terms and by the same test — it must own
     `role="row"` descendants of its own (§7.9) — so a `<div role="grid">`
     of `<div role="row">`s under the wrapper IS the one thing with rows and
     reads as a table. Nothing with rows fails as
     `readTable found no table with rows under "<selector>"`, which now means
     no `<table>` and no ARIA grid with data rows. A `<table>` with rows
     beside an ARIA grid with rows is
     `readTable found a table and an ARIA grid with rows under "<selector>" — it must be exactly one, so select the one you mean`,
     and two grids
     `readTable found <n> ARIA grids with rows under "<selector>" — it must be exactly one, so select the one you mean`
     (§7.9). Two or more tables
     with rows fail as
     `readTable found 2 tables with rows under "<selector>" — it must be exactly one; a grid with frozen (locked) columns splits its rows across two tables, which is not supported`,
     because reading one half would be the misalignment this action exists
     to prevent (two whole grids under one wrapper get the same sentence;
     the cause it names is the usual one).
4. The label the diagnostics use is, in order: the read table's own
   `aria-label`, its `<caption>`, or the text its `aria-labelledby` resolves
   to — an ARIA grid reads the same chain, minus the `<caption>` it cannot
   have, and falls back to its `id` (§7.9); the GRID's name — the wrapper the selector named or, once a header
   has been found in another table (§7.3a), the nearest common ancestor of
   the two — by its `aria-label`, then the text its `aria-labelledby` names,
   then its `id`; the read table's `id`; the selector. The grid is named
   BEFORE the width and adopted-header refusals fire, so they name it too.
   The grid's name beats the table's `id` because Kendo's row table carries
   a GUID (`id="14277be2-015b-…"`), and a failure that names that names
   nothing the author can find; and Kendo's tables have `role="none"` and no
   name of their own, so without the wrapper's a failure would read
   `cannot map table "#holdings-grid .k-grid-content table"`.

### 7.3 Header mapping

A header row is required only when some requested column names a header. The
header rows belong to the selected table (or, failing any, to the table §7.3a
pairs it with):

- normally the rows of its direct `<thead>` — one row, or several laid out
  into one header grid as §7.3b says;
- when the `<thead>` is **absent or holds no rows**, the body-row rule
  applies: the
  first body row that contains at least one `<th>`, has no cell with
  `scope="row"`, and is not a single cell spanning more than one column is
  the header row. That admits the common
  `<tr><td></td><th>Order ID</th><th>Status</th></tr>` (a checkbox cell
  beside headings) and a one-column `<tr><th>Order ID</th></tr>`, and keeps
  out a `<th scope="row">` row (§10, that row's own heading) and a lone
  full-width group `<th>` (§4.8). Neither half of that is incidental: "at
  least one `<th>`" rather than "all cells are `<th>`" is what admits the
  checkbox case, and "absent **or holding no rows**" is what reads a
  framework's `<thead></thead>` with the headings in the first `<tbody>`
  row. A `<thead>` that HAS a row is never this case, however blank that
  row's cells are: that one is §7.3b.5's, and the difference matters,
  because the body-row rule must not run there;
- exactly **one** body row is considered for that, and it is the first that
  is rendered or carries a `<th>` — a `display:none` template row, the
  standard way to clone a row in plain JS, sits in front of the headings and
  otherwise produced both failures above. Only the first: a `<th>` further
  down (a row-header column with no `scope` attribute is the realistic case)
  must not be reachable, or the read would silently delete a data row from
  the middle of the table. One exception, as narrow as the rule that needs
  it: a candidate that is a single `<th>` cell, in a table where a wider heading row — one carrying MORE THAN ONE `<th>` — follows it, is a group heading (§4.8), not the header — a
  header is never narrower than the grid it names — so it is stepped over
  and the next rendered-or-`<th>` row is the one candidate instead. The skip
  counts CELLS, not columns, so
  `<tr><th colspan="3">Group A</th></tr>` is stepped over as well — it is
  one cell — and it is not limited to a candidate that would otherwise have
  been accepted, since that one is refused by the spanning-cell rule rather
  than taken as the header. What the skip does require is a `<th>`: a
  one-cell `<td>` row still ends the search with no header, which is what
  keeps a row-header `<th>` further down unreachable. With no wider heading
  row below it, a one-cell `<th>` row IS the header, however wide the data
  rows beneath it are (§7.4: extra cells are harmless). "More than one" is what tells a
  heading row from a row header: a row naming the columns names them all,
  whereas a single `<th>` beside `<td>`s (`<tr><th>O-1</th><td>Delete</td></tr>`,
  the row-header column §10 names) is data, and must not make a one-cell
  `<th>` above it look like a group heading — or the read steps over the
  real header and deletes the `O-1` row from the middle of the table. The
  residual limit is the mirror image: a genuine heading row with a single
  `<th>` beside `<td>`s (`<tr><th>Name</th><td>Actions</td></tr>`) is not
  recognised as one, so a group row above IT is not stepped over. Stepping
  over does not delete anything by itself — the row goes back into the body —
  but §4.8 then classifies it like any other body row, and the two answers it
  can give are different enough to be worth stating apart:

  - a group row whose cell SPANS the grid
    (`<tr><th colspan="3">Group A</th></tr>` above a three-column heading
    row) is a **placeholder** by §4.8's `colSpan >= max(width, 2)` rule. It
    is dropped, it gets no `_row`, and it is counted in the "N placeholder
    rows skipped" line. Measured on that table: a read of one column gives
    `Alice` and `Bob` numbered 1 and 2 with one placeholder skipped, and a
    read of two columns SUCCEEDS — the spanned row never reaches the mapping
    step at all;
  - a group row whose cell does NOT span
    (`<tr><th colspan="1">Group A</th></tr>`, or the same with no `colspan`
    attribute) is **data**, because §4.8's floor of 2 makes a lone cell
    spanning one column data. It stays in the body as an ordinary row, so a
    read of one column makes it record 1 holding that cell's own text
    (`Group A`, `Alice`, `Bob`, numbered 1 to 3) and a read of two columns
    fails the whole read with
    `readTable cannot map table "<label>": row 1 has 1 cell, so there is no cell for the "<column>" column at position 2`
    (§10).

  Two further residual limits were measured in review 6 and left as known
  limitations rather than fixed, because each candidate fix moves the line
  and the next shape is not known: a totals row inside `<tbody>` carrying two
  `<th>` cells counts as the wider heading row and steps over a genuine
  one-cell `<th>` header above it (the same row in `<tfoot>` does not), and a
  headerless table whose body rows are ALL unscoped row-header rows
  (`<tr><th>O-1</th><td>Delete</td></tr>` with nothing above them) takes its
  first row as the header and loses that row from the read, with
  `scope="row"` as the escape hatch. See
  [issues/058](../../issues/058-tbody-totals-row-steps-over-a-one-cell-header.md)
  and
  [issues/059](../../issues/059-all-row-header-table-loses-its-first-row.md);
- nested-table rows/cells are excluded by requiring `closest('table')` to be
  the selected table.

If no header row exists — in the table, or in another table §7.3a can pair it
with — and a column names one, fail with the §5.4 message, which tells the
author to name columns by position. If every requested column
is positional, the header row (if any) is still identified so that it is
excluded from the body and so the placeholder-row rule (§7.4) knows the
table's width, but nothing is matched against it.

A positional column (`index`) maps to the cell at that one-based position in
each body row. It ignores the header entirely, so a reordered table changes
what it reads; that is the documented trade-off of §4.4, not a bug.

For each column of the header grid (§7.3b):

1. take the lowest heading cell covering it; a cell spanning columns names
   each of them, and a cell spanning rows is the lowest over its column when
   nothing sits below it;
2. derive header text from rendered text (`innerText`), with the
   form-control subtraction of §7.3b.3, falling back to trimmed
   `textContent` — skipping those same controls — for visually-hidden
   accessible headings;
3. normalize by trimming, collapsing whitespace, and case-folding;
4. match each requested header by normalized exact equality, never substring.

Every requested header must match exactly one column. A missing header fails
the action and lists the available non-empty headers; a header that matches
more than one column fails it and lists the matching **positions**, so the
author can name the one they mean by position (§10). Positions rather than
headers there: the headers are what the author already typed.

Blank selection-column headers are valid and ignored unless somehow requested.

Case-folding is load-bearing, not tidiness: the app's table style sets
`text-transform: uppercase` on `<th>`, so `innerText` of the Orders header
is `ORDER ID` while the author wrote `Order ID` and `textContent` says so
too. Step 3's fold makes all three the same key. `tests/read-table.test.ts`
must include a header styled that way.

### 7.3b Header rows: the header grid

More than one header row is the norm for a grid widget: a band row over
groups of columns, the column names, and often a filter row of inputs
(RadGrid, §5.7; Kendo's column groups; DevExpress bands). V1 read exactly one
row and refused the rest as "merged"; measured on RadGrid, that refused every
read by header. The rows are laid out instead, the way the HTML specification
lays a table out:

1. **The header rows** are every row of the selected table's direct `<thead>`
   when it has one; otherwise the one body row §7.3 accepts. A body-row
   header is always one row.
2. **The grid.** Rows are placed top to bottom. Each cell takes the first
   column in its row not already occupied by a cell from a row above, and
   occupies `colspan` columns across and `rowspan` rows down (`rowspan="0"`,
   "to the end of the row group", runs to the last header row). The width is
   the highest column any cell reached, plus one. RadGrid's header is nine
   wide from a band row of four cells and a name row of eight: the blank
   first cell spans both rows.
3. **Naming.** The name of a column is the heading text (case-folded on
   match) of the LOWEST cell covering it that has non-blank text. A cell's
   heading text is its RENDERED text with the rendered text of each `input`,
   `select` or `textarea` inside it removed — a `button`'s text stays,
   because a sortable heading's title lives in one — and only when that
   leaves nothing — and the cell holds no RENDERED control — does §7.3's
   visually-hidden fallback read `textContent`, skipping the text inside
   those same three controls: a cell that renders a control renders
   something, and names nothing; an unrendered control (`<input
   type="hidden">`) does not block the fallback, which is what keeps
   RadGrid's expand column named from its hidden span. Measured before the
   subtraction: the Status filter's `<select>` rendered `All`, which became
   the name of the Status column and failed every read of it. Measured
   before the fallback was narrowed the same way: a cell holding any control
   switched wholesale to a raw text walk that read `display:none` text, so
   `<th>Status<span style="display:none">SORTKEY</span><input type="hidden"></th>`
   named its column `StatusSORTKEY`, and a filter cell's hidden span became
   a column name. A cell with blank text — an empty corner, a filter cell holding
   only a control — names nothing, so a filter row is laid out (it can widen
   the grid) and never names a column. A column no cell names is blank, and
   is ignored unless requested, as today.
4. **Bands.** A cell whose every column has a non-blank cell below it is a
   band: it groups, it does not name. A requested header that matches a band
   and no leaf fails with the §5.3 sentence, listing the leaves under it. A
   requested header may be written `Band > Leaf` (`Q1 > Fee`), split on the
   `>` with any whitespace around it — `Q1>Fee`, `Q1 > Fee` and `Q1  >  Fee`
   are one request: the last segment must match the leaf and each earlier
   segment, from the top down, a band over that column; that is how repeated
   leaf names under different bands are told apart, and the plain repeated
   name lists positions as §7.3 says. The PLAIN reading is tried first — the
   whole requested string matched against the column names as written — so a
   heading that genuinely contains a `>` (`Fees > $100`) still matches
   itself, and the band split is only what happens when no column is named
   that.
5. **No header.** A `<thead>` whose grid names no column at all — RadGrid's
   data table has one, hidden, with a single empty `<th>` — is no header: the
   table is treated as having none, so §7.3a can find the real one beside it
   or through `aria-owns`. The body-row search of §7.3 is NOT run in its
   place: an unscoped row-header `<th>` in the first data row would then be
   taken for the header and a record deleted from the read, which is
   issue 059's shape. Measured: with the empty row taken as the header,
   every read by name failed "its header row has no non-empty headings" one
   table away from the headings. This applies to a `<thead>` **only**. A
   BODY row that §7.3 accepted as the header is still the header when its
   cells are all blank, and is still spliced out of the body: it was chosen
   for its shape, not its words, and there is no other table to go looking
   in. Measured with the `<thead>`-only limit missing: such a row became
   record 1 and shifted every `_row` below it by one.
6. **What is still refused.** Nothing about the header: the "merged headers"
   and "its header has N rows" sentences are gone. Body cells that span are
   the §7.4 error as before. A leaf cell spanning two columns names both, so a
   request for it is the duplicate-header refusal with positions, and a
   positional read works.

The width every later rule uses — the placeholder rule of §4.8, the
short-row refusal of §7.4, the pairing check of §7.3a — is the header grid's
width, not a row's cell count.

### 7.3a Header in another table

A table with no header row of its own — no `<thead>` row and no body row §7.3
accepts — may take its header from another table, in one of two ways, tried
in this order. Both exist for the grid of §5.6, where the header and the rows
are separate `<table>` elements, and neither applies to a table that has a
header of its own: a header in the table always wins.

1. **Declared.** The selected table's `aria-owns` names elements by id. If
   one of them is a `<thead>` or a `<tr>` whose nearest `<table>` is a
   different table, that table's header grid (§7.3b) is the header. Kendo
   writes exactly this on the row table:
   `aria-owns="<header thead id> <own tbody id>"`. The page said which header
   is this table's, so the name and contiguity conditions below do not apply;
   the width check does.
2. **Beside it.** Otherwise — and only when the selected table does not name
   itself: a non-empty `aria-label`, an `aria-labelledby` that resolves to
   text, or a `<caption>` with text makes it a whole table, never half of a
   grid, and ends this path with no search and no refusal — walk up from the
   selected table, ancestor by ancestor, BELOW `<body>`: a grid widget always
   has a wrapper of its own, so `<body>` is never the container and the walk
   ends with no candidate when the next ancestor would be it. (Walking to
   `<body>` was measured to pair an unnamed empty table in one `<div>` with an
   unrelated headerless table in the next, and to refuse the empty one as
   "only the header row" where §4.8 says `[]`.) At each ancestor the
   candidates are the tables under it that:
   - precede the selected table in document order;
   - are rendered;
   - are **header-only**: their header grid (§7.3b) names at least one
     column and they have no DATA row — no body row that is not a §4.8
     message row. Kendo's header table is a `<thead>` with no `<tbody>` at
     all; RadGrid's has one hidden spacer `<td colspan="9">` row, which is a
     message row and so does not count; a framework that puts the headings
     in the first `<tbody>` row and nothing under it qualifies the same way.
     A table with data rows is never a candidate, and a table with neither
     (a footer holding a `<tfoot>` alone, a pager whose one row is a lone
     spanning cell) is ignored;
   - are not nested inside ANY table — asked of the candidate outright, not
     relative to the ancestor: asked relative to it, two tables sitting in
     two cells of an enclosing layout table paired once the walk reached
     that table's row, and a table inside a header-only table's `<th>`
     adopted the header around it;
   - do not name themselves (the same three forms as above; a dangling
     `aria-labelledby` or an empty `<caption>` is not a name). A named empty
     table above a headerless one is a whole table, not a header half.
     Kendo's tables carry `role="none"` and no name;
   - are contiguous with the selected table: between the candidate's end and
     the selected table's start in document order there is no rendered text
     outside a table, and no table WITH ROWS — a data table sitting between
     them is that header's own partner. Text inside a header-only table
     between them does not break contiguity: in Kendo's frozen grid the
     second header table sits between the first and the rows, and both must
     be seen for the refusal below to fire. A fixed-header grid is
     contiguous; two tables have a heading between them. Empty wrapper
     `<div>`s, `<colgroup>`s and scrollbar padding are not text.

   Stop at the first ancestor with at least one candidate (stopping at the
   nearest ancestor that merely contained another table was measured to
   miss Kendo's frozen grid: the unlocked row table's nearest table-bearing
   ancestor is `div.k-grid-container`, which holds the locked row table and
   no header). Then count:
   - two or more candidates is a grid with frozen (locked) columns, or a
     page shaped like one — two unnamed header-only tables above an unnamed
     headerless one with nothing but tables between them — and is refused:
     `readTable found 2 header-only tables beside "<label>" — it must be exactly one; a grid with frozen (locked) columns splits its header across two tables, which is not supported`.
     Naming either table (§10) reads the page as separate tables again;
   - exactly one: the widths must match — the header GRID's width (§7.3b),
     not the cell count of any one of its rows, equals the selected table's
     widest body row, rendered or not, measured
     over the body rows that are not §4.8 message rows (a lone cell spanning
     more than its own column, a lone rendered cell among unrendered
     fillers, or a row with no cells; `colspan > 1` is the test here, the
     §4.8 rule without the width it is about to measure). Measured over
     every row, an emptied grid whose only row is
     `<td colspan="6">No records available.</td>` is one cell wide against a
     six-cell header, and was refused instead of reading `[]`; with no
     non-message row the check is skipped. A mismatch is refused with both
     counts —
     `readTable cannot map table "<label>": the header table has <H> cells but its widest row has <W> — the two tables do not line up`
     — because a header one column off is the §4.5 misalignment with a
     plausible face. The same check, and the same sentence, apply to a header
     the row table declared through `aria-owns`;
   - none leaves the table headerless, as today.

3. **The header-only pick.** The mirror image, and the case that made this
   section necessary: the selected table HAS a header row and no DATA rows
   — no body row that is not a §4.8 message row, so RadGrid's header table,
   which keeps a hidden spacer row in its body, is still the pick — and
   either another table's `aria-owns` — anywhere in the document, before
   or after it — names that header (declared), or a rendered headerless
   table with rows after it, under an ancestor below `<body>`, would adopt
   this table's header by the rules in 2 (beside it: the search is run from
   THAT table's side, so the refusal fires exactly when selecting it would
   have paired the two). Then the read FAILS:
   `readTable cannot read table "<label>": it holds only the header row; the rows are in the table beside it — select the element that contains both ("#holdings-grid") or that table`
   — the parenthesised selector is the wrapper's `#id` (CSS-escaped, so a
   GUID id comes out pasteable) or its `[aria-label='…']` (single quotes,
   because it sits inside a double-quoted parenthetical), and with neither
   the sentence is
   `… — select the element that contains both or that table`. When the
   search from the row table's side finds two or more candidates and this
   table is one of them, this is a frozen grid's header table, and the
   refusal says so:
   `readTable cannot read table "<label>": it holds only the header row of a grid with frozen (locked) columns, which is not supported`
   — measured before this sentence existed, both header tables of the frozen
   fixture read `[]` and passed. This probe runs BEFORE the width check, so a
   pair whose widths do not line up is refused this way rather than read as
   `[]`. Without such a partner, a header with no rows is an empty table and
   stores `[]` as before (§4.8). This is what stops the one selector a model
   reaches for first — the table where it can SEE the words "Order ID" — from
   passing green with nothing read.

With a header adopted, nothing else changes: a positional column is a
position in the selected table's rows; header text is normalised and matched
exactly as §7.3 says; a blank header (the checkbox column) is ignored; the
placeholder rule uses the adopted header's width. `_row` numbers the selected
table's data rows. The summary line says where the header came from (§7.6).

What this does not read: a grid with frozen (locked) columns — four tables,
the rows split by column across two of them — stays deferred (§14), and the
four ways into it come out like this, each measured on the fixture: the
wrapper is refused (two tables with rows); either header table is refused
(the frozen sentence above); the locked row table is refused (two header-only
candidates: the second header table sits between the first and it, and a
header-only table's text does not break contiguity); and the unlocked row
table is HEADERLESS — the locked row table sits between both headers and it,
and a table with rows does break contiguity — so a header-named read of it
fails with the §5.4 message and a positional read returns that table's own
columns, three of the grid's five, exactly as it did before this section
existed. The one frozen form that reads by header is a row table that
DECLARES its header through `aria-owns`, as current Kendo does: that half is
then the table it says it is, its headers are the unlocked columns only, a
request for a locked one fails naming the available headers, and a request
for unlocked ones returns them — the same rows in the same order, so nothing
is misaligned. A grid that repeats the header table for a second scroll pane
is refused the same way as frozen columns, and a virtualised grid still
yields only the rows it has rendered (§10).

### 7.4 Row mapping

- Read direct rows from all direct `<tbody>` elements belonging to the
  table, and rows placed directly under `<table>` — HTML source always gets a
  `<tbody>` from the parser, but `table.appendChild(tr)` does not, and a
  scan of `tBodies` alone read such a table as `[]`, green.
- Exclude `<thead>` and `<tfoot>` rows.
- Exclude rows which are not visible at capture time (`display:none`,
  `visibility:hidden`, hidden/collapsed ancestors, or no rendered client
  rect) — with one exception: a row or cell whose computed `display` is
  `contents` has no box of its own and is rendered if its content is. That
  is the standard idiom for laying a semantic `<table>` out with CSS grid
  (`tr { display: contents }`), and a client-rect test alone dropped every
  row of one, so the read stored `[]` and succeeded.
- Exclude nested-table rows.
- Preserve DOM order.
- Drop placeholder rows (§4.8): a row whose only cell has a `colspan` of at
  least `max(width, 2)`, or whose only RENDERED cell does while every other
  cell in the row is unrendered (Kendo's group row, §5.6: one spanning cell
  and five `<td hidden>` fillers), where the width is the header GRID's
  width (§7.3b) or, with no header, the widest body row's cell count over
  **all** body rows, rendered or not. A row with no cells is dropped the
  same way. Both are counted, for the
  log line of §7.6. If every body row was a placeholder, the result is `[]`.
  This test runs BEFORE the merged-cell rejection below — that order is what
  lets `<td colspan="5">No documents uploaded yet.</td>` answer `[]` instead
  of failing the read of an empty table.
- Drop **detail rows** in the same pass, before anything is numbered and
  before `limit`: a body row at least **two cells short of the width**
  (`width − cells >= 2`) with no `rowspan` and column spans that together
  COVER the width (a `colspan` in it, and the spans summing to at least the
  width) is not a grid row — it is the row a widget inserts under an
  expanded record (RadGrid, §5.7; Kendo's `k-detail-row`; DevExpress
  master-detail), an expand cell beside one wide cell holding a template and
  often a nested table. Skipped, counted with the placeholders, its nested
  table excluded. Measured before the rule: one expand made the next read
  fail as a short row, on every grid that has expandable rows. The cover
  test is what keeps §10's `<td colspan="3">` in a five-column table a
  refusal: three of five is a merged cell, nine of nine is a detail row. The
  two-cell margin is the other half of the same line: at width three,
  `<td>a</td><td colspan="2">b</td>` covers the width from only one cell
  short and is indistinguishable from a merged data row, so it reads as the
  merged-cell refusal again, as it did on main. RadGrid's two cells for nine
  columns, and Kendo's two-cell detail rows, are seven short and more, and
  are still skipped.
- Number what is left: `_row` is the one-based position among the remaining
  data rows, hidden rows, placeholders and detail rows excluded. Write it on
  every record before the requested columns, so the report and the Variables
  panel show it first.
- With `limit`, select the first `limit` of those rows before cell extraction.
  Without `limit`, all of them.
- Reject any other body cell that spans: a `rowspan` other than 1 (it
  shifts the rows below — `rowspan="0"`, legal HTML for "to the end of this
  row group", is reported by the DOM as `0`), and a `colspan` greater than 1
  in ANY row that was not already skipped as a placeholder or a detail row.
  That includes a SHORT row whose spans do not reach the width — which is
  what keeps §5.5's `<td colspan="3">` in a five-column table a refusal —
  as well as a row that already has as many cells as the grid is wide, which
  is a row wider than the grid. Silently guessing where such a row's values
  fall is the misalignment this action exists to prevent.
- A row missing any requested logical cell fails the whole action and names the
  row's `_row` and the header or position. Never drop the row or shift values.
  Cell-shape validation applies to selected rows; an unselected row after the
  explicit limit cannot fail the bounded read.
- Extra cells are harmless.

**The numbering is left on the page.** In the same evaluation that builds
the records, every data row of the read table — all of them, not only the
`limit`-selected ones — is stamped `data-aiui-row="N"`, N being exactly the
`_row` its record carries. The stamps are written only when the read
SUCCEEDS: a read refused for any reason leaves the page exactly as it found
it, so a failed step never leaves a numbering behind for a later step to
trust. Before they are written, every stale stamp inside the read table is
cleared — on every DESCENDANT of that table, the rows of a nested table
included, not merely on the rows this read is about to number, or a detail
row's nested table keeps whatever numbering an earlier read of it left.
Nothing OUTSIDE the read table is cleared or stamped. Header, filter,
spacer, placeholder, detail and hidden rows get no stamp. It is the one DOM change
the extractor makes, and it exists because of a measured failure: asked to
"Click Review in row 7", the model reasoned "the seventh data row" and
computed the id `RadGrid1_ctl00__7`, which is the EIGHTH row, and the step
passed green having reviewed the wrong applicant. A later step now finds
"row 7" as the row matching `[data-aiui-row="7"]` inside that table, which is
the framework's own count and cannot drift from the record. A re-read after
paging, sorting or filtering renumbers; a re-render that drops the
attributes leaves nothing stale, only nothing, and the model falls back to
counting data rows in the snapshot (§6.3). The snapshot keeps the attribute.

Cell value v1 is rendered cell text: trimmed and with runs of whitespace
collapsed to one space. Nested links/spans therefore read normally. An empty
cell is stored as `""` and is not dropped.

A requested cell containing only a form control or icon therefore produces
`""` in phase 1. Reading control state — `mode: 'checked'` for a checkbox or
toggle, `'value'` for an input or a select's chosen option, `'attribute'` with
a name — is phase 2 (§1.3), behind that explicit per-column mode; phase 1 must
not guess that `<input value="on">` means checked. The author-facing form is
fixed now so phase 2 adds no syntax: “the Auto-pay checkbox as autopay” reads
the checkbox's state as `"true"`/`"false"`, “the Amount input's value as
amount” reads the field, and phase 1 refuses both with a message naming the
phase rather than silently storing `""`.

### 7.5 Limits and atomicity

- Maximum requested columns: 20 — enforced in the parser and again in the
  shared extractor, since §9.2 needs both paths to validate identically.
- Maximum output rows: 500. Consequently, `limit` must be between 1 and 500.
- With no `limit`, if the table has more than 500 visible rows, fail. Unlike the
  existing flat plural read, do not silently truncate structured records: a
  partial business table can produce a convincingly wrong result.
- With an explicit `limit`, a table may contain more than 500 visible rows. Read
  only the first `limit`. This is intentional author-requested selection, not a
  safety-cap truncation.
- If fewer than `limit` visible rows exist, return them all without error. That
  is not an implicit cardinality assertion.
- Extract headers and rows in one browser-context evaluation after locator
  uniqueness is established, so a rerender cannot put headers from one version
  beside rows from another.
- Return `[]` for zero visible body rows.
- Preserve column order from the action when constructing each object.

### 7.6 Logging and reports

Log a summary, not the complete data set:

```text
readTable captured 2 rows × 3 columns as "{{orders}}"
```

For a bounded read, include the requested bound so a short table is observable
without logging its contents:

```text
readTable captured 7 rows × 1 column as "{{orders}}" (limit 10)
```

When placeholder rows were skipped, say so, so an unexpectedly short result
can be explained from the log alone:

```text
readTable captured 0 rows × 2 columns as "{{docs}}" (1 placeholder row skipped)
```

When the header came from another table (§7.3a) — declared through
`aria-owns` or found beside the rows — say so, so a wrong pairing can be
seen from the log alone:

```text
readTable captured 6 rows × 3 columns as "{{holdings}}" (header from a separate table)
readTable captured 5 rows × 3 columns as "{{dividends}}" (2 placeholder rows skipped, header from a separate table)
```

The note comes after the bound and the placeholder count, and is last unless
the structure question was involved: §7.10's `structure from the …` note
goes last of all, because it is the one that says the records came from an
answer rather than from the markup.

Do not write every captured cell to the normal console/run log. Existing
variable/report surfaces may show captured variables, but their secret masking
must look INSIDE a capture rather than only at the name it is stored under:
values under a key the record-column rule below calls a secret must be masked
even though the root variable is named `orders`.

**Two rules, because a name has two possible authors.** A flat name is the
test author's — a parameter, a `[store as:]` capture, a `${…}` reference — and
it takes the broad substring rule (`isSecretName`: `password`, `secret`,
`token` or `key` anywhere in it). A record's keys are not: they come off the
page, as a `readTable` column alias or a header turned into a property, and
there the same breadth masks the wrong things — `keyword` and `sort_key` both
contain `key`, and masking is not a free precaution because the value is then
replaced EVERYWHERE, including in the DOM snapshot the model plans its next
action from. So a record column takes the narrow rule (`isRecordSecretKey`):
`password`/`passwd`/`pwd`/`secret`/`token`/`otp`/`credential(s)` as whole
words, and `key` only where something makes it a credential (`api_key`,
`apiKey`, `access_key`, `private_key`, `auth_key`, `signing_key`,
`encryption_key`). A camelCase hump is a word boundary, so `apiKey` is a
secret column and `apikey` — one word, no boundary — is not.

A dotted binding is where the two meet. `row.<column>` (§8.4) is a secret if
**either** half says so: the root by the author-chosen rule, the property by
the record-column one. `{{token.payee}}` is masked because the author called
the record `token`; `{{payment.password}}` because the page called the column
`password`; `{{payment.sort_key}}` is not masked by either.

**The four-character floor governs only the free-text mask set.** A record
value shorter than four characters is never *added* to it: a `token` column
holding `-` and `7` would otherwise turn every dash and every seven in every
output into `***`, the DOM snapshot included. An entry masked by its NAME
has no such floor: it is replaced in place, under its own key, where it
reaches nothing else, so a one-character `payment.password` still renders as the mask and a
`password` parameter is hidden whatever its length. The scan must not depend
on the JSON's formatting (a tool may pretty-print), and its result is memoised
per value so `secretsNow()` does not re-parse a 500-row capture on every call.

**The client masks the values; the wire tells it how.** `frame:scope` carries
raw values by design, so TestBench's Variables view and Variables panel apply
the same two rules themselves — including inside a value that holds records,
which is the one case no name rule can catch: `payments` is a whole table and
`payment` one record of it, both under names the author chose and neither of
which says secret. They render with each secret column replaced and the rest
readable, which is what makes the view worth looking at mid-loop.

What the rules cannot read off a name, the event says outright. A scope is a
mixed map — `payment.keyword` is a page's column, bound by a pass, while
`user.apikey` is a data file's own heading — and which is which lives in a
registry keyed on the server's live map, an object the wire cannot send. So
`frame:scope` carries two optional fields beside `scope`:

- **`bindings: string[]`** — the dotted names a `For each` pass has bound into
  that map, as of this event. A name in it takes the two-segment rule above; a
  dotted name that is *not* in it is the author's end to end and takes the
  flat author rule on the whole key, exactly as `isSecretParameterName(name,
  map)` decides it server-side. Sent on every `frame:scope`, **empty list
  included** — an absent field has to keep meaning "an older server said
  nothing", because reading absence as "bound nothing" would mask `AU` out of
  a real loop's `row.keyword` against a server that never claimed it was the
  author's word. It is the empty list that makes a test with no loop in it
  mask its `user.apikey`.
- **`unmask: string[]`** — the run's `## Config: unmask:` names, sent only
  when it has any. A name in it renders in full, exempt from all three rules,
  the way `formatParameterBlock` exempts it: masking a declared non-secret by
  its value or by its record shape would take the hatch away through the other
  door.

Both are read by one client entry point — `maskIfSecret(name, value, {
bindings, unmask })` in `runner-core/src/repl.ts`, mirrored inline as
`maskIfSecretInline` for the webview bundle — so the Variables view, the
Variables panel and the skill re-run rows cannot answer differently. A third
argument rather than a second function, because a surface that keeps calling
the old one compiles, runs, and quietly answers the pre-wire way.

The client's copies of both rules must be the server's, not merely close to
them. Either direction of a difference is a defect, and the leaking one is
quiet: a name the client alone thinks is innocent shows a value the report
beside it redacts. That the author-chosen rule is a SUBSTRING is part of what
must be copied — `mypassword` and `apitoken` are secrets — and the cost of
that breadth (a flat `keyword` masked on both sides) is accepted rather than
tuned out on the client, because a view that disagrees with the report about
one row is the worse failure.

That copying includes WHICH rule each surface asks. The client has both map
rules too: the two-segment one for a scope entry, which may be a loop binding,
and the flat author rule on the whole key for a data row's cells and for a
`[store as:]` capture — the surfaces the server gives `redactAuthoredMap`.
Applying the scope rule to an author-chosen map prints `user.apikey =
uk_live_1234` in the Run Rows pick, the gutter hover and the Output banner
beside a report matrix that says `***`, so which rule a surface asks is part
of the contract, not an implementation detail.

**The `unmask` hatch reaches what is shown LIVE, and nothing that is written
to a file.** It exists because `isSecretName` matches `keyword`, and a column
the model has to find in the DOM arriving as `***` costs the model its eyes
rather than merely its logs — so the hatch governs the prompt's `## Values`
block, and now, over `frame:scope`, TestBench's Variables view, its Variables
panel and the skill re-run rows. The report, the run log, the console step
line and the compile recording are deliberately untouched by it
(`src/parser/types.ts`): they are artefacts that leave the machine, and an
`unmask` line in a test file must not be able to put a real credential in one.

So a run that unmasks `keyword` shows it in the view and stars it in the
report, and that is the one place those two are meant to differ. It is not the
disagreement this section forbids — that one is about a rule the client got
wrong, and this is the author's own declaration reaching the surfaces they are
looking at while they debug. Two surfaces the hatch still does not reach are
gaps rather than policy: the `[input:]` echo and the gutter hover render an
author-chosen map through `maskIfSecretAuthored`, with no run attached to ask.

The server can only forward a list it was given, and on the TestBench path it
is not given one yet — `RunController`'s per-session `config` carries
`baseUrl`, `timeout` and `viewport` and nothing else (§14), so `## Config:
unmask:` is inert end to end for a TestBench run and `frame:scope` carries no
`unmask` field on it. The CLI and MCP paths read the hatch straight off the
parsed test, so it works there today, and the wire is ready for the day the
extension sends it.

**A leading byte-order mark is stripped before a value is sniffed for JSON.**
Every copy of that scan, server and client, strips it first; a value nothing
was masked in is still returned exactly as it arrived, mark included. The
strip is required rather than defensive: U+FEFF is whitespace to a JavaScript
regex, so a marked value clears a `/^\s*[[{]/` sniff and then throws in
`JSON.parse`, and the catch hands the value back untouched — which on a
record-shaped value is the one outcome this masking exists to prevent.

**A secret column masks at whatever JSON type the cell holds.** A `password`
column holding `123` is the same credential as one holding `"123"`, so the
client surfaces mask a number or a boolean exactly as they mask a string, and
so does the server wherever it masks a record in place. Only a NUMBER also
joins the free-text mask set, in its JSON spelling (`123`, not `"123"`, the
form that occurs in the capture and in any prose quoting it) and under the
same four-character floor. A boolean does not: `true` clears the floor, and a
`token` column holding one would turn every "true" in the DOM snapshot into
the mask. A cell that is null, an object or an array is left as it is: null
says there is no value to hide, and nothing on either side walks into a
nested object to mask what is under it.

**The prompt's `## Values` block is a surface like the others.** It renders
a record capture with its secret columns masked by the record-column rule,
then masks what is left by the run's secret values — so `{{payments}}` and
`{{payment}}` say `***` in the same places the DOM beside them does. A name
the test has unmasked (`## Config`'s hatch) is exempt from both, otherwise
the hatch would be taken away through the other door. The code-behind
compile and repair prompts share the formatter and so get the record-column
masking; they carry no free-text mask set, which is the state they were in
before this feature.

**A secret joins the mask set in both its raw and its JSON-escaped
spelling**, whichever surface named it — a parameter, a record cell, an
`${env.X}` or a `${data…}` secret alike. A capture is stored as JSON, so a
value holding a double quote or a backslash (a Windows key path is the common
one) sits in the variable, the report's parameter map and any trace payload
in its escaped form, which the raw spelling does not match.

**Which name rule a dotted entry gets follows from whose name it is, not
from how it is spelled.** The live variable map is mixed: a `For each` pass
writes `row.<column>` bindings into it, and `resolveParameters` merges a
data file's cells into the same map under the file's own headings, so an
author-typed `user.apikey` sits beside a page-derived `row.keyword`. A pass
therefore REGISTERS the names it binds (a registry keyed by the map object,
kept beside the masking rules), and only a registered name is read as half
page-derived — its root by the author rule, its property by the whole-word
record rule, the whole name by the credential-key reading (`api.key` →
`api_key`, `private.key`). Every other dotted name in that map is one a
person typed and takes the author rule on the whole key, as it did before
the rule was split; the accepted direction is that an unregistered
`row.keyword` — a CSV heading that happens to look like a binding — masks,
and the way out is `## Config`'s `unmask`. A rebind that drops a dotted key
drops its registration with it, so a `Set` or a capture after a loop leaves
nobody's binding behind. Asked about a name with no map in hand, the rule
reads it as a binding — which is why the registry travels on `frame:scope` as
a list of names, so the client is not asking without one. A copy of the map (the server merges frame inputs
into one before it takes the mask set) inherits the registration, or every
binding in the copy would fall back to the author rule and `AU` would
rejoin the mask set. A map whose keys are author-chosen end to end — a data
row's cells in the report's matrix band, a step's `[store as:]` tool outputs
in a recording — is masked by the author rule on the whole key without
consulting any registry, and a data row the run never reached is masked the
same way as one it did.

**The free-text scan accepts a single record as well as a list.** A value
beginning, after any byte-order mark, with `[` or `{` is parsed, and a lone
record is read as a list of one: `[store as: account]` on a one-row read
stores `{…}`, and the two halves of record masking must accept the same
shapes, or the same column reads as the mask in the Variables panel and in
clear in the run log.

**The mask string differs per surface, and that is by design.** The server
writes `***` wherever it masks (report, log, prompt); the client writes a run
of asterisks, one per character of the value up to eight
(`********`), because its mask replaces one displayed value in place rather
than a substring of free text, and a length hint helps an author tell an
empty capture from a short one. The two never appear in one document, so
nothing compares them.

An **empty** value is the one place the client writes neither: it writes
`(empty)`, the same word the server's `redactMap` writes (`EMPTY`,
src/utils/secrets.ts), so the Output banner and the report say the same thing
about the same cell. Saying a field was blank discloses nothing, and a row of
stars over an empty cell leaves a report matrix unable to tell "wrong
password" from "no password" — the two rows of a data table that most need
telling apart.

The action is observational and must not trigger post-action page settling.

### 7.7 Whole-table assertions (phase 2)

The assertions of §4.9 are deterministic steps over a captured list. They are
parsed from the step text the way `Set` and the control lines are — a fixed
grammar, not the model's reading of it — and they never call the model; the
list is the evidence, and the failure message shows the offending rows.

Four forms cover the cases in §4.9:

| Form | Passes when |
| --- | --- |
| `Verify every row in {{list}} has a <key> of "a", "b" or "c"` | Each record's `<key>` is one of the quoted values. Also `is "a"` / `is not empty` / `is empty` / `contains "x"`. |
| `Verify no two rows in {{list}} share a <key>` | The `<key>` values are pairwise distinct, ignoring empty ones. |
| `Verify the rows in {{list}} are sorted by <key>, earliest first` | The `<key>` values are non-decreasing (`latest first` / `largest first` for non-increasing) under the comparison below. |
| `Verify the <key> values in {{list}} add up to "<total>"` | The numeric sum of `<key>` equals the numeric value of `<total>`. |

`<key>` is matched case-insensitively against the record keys, with spaces
allowed for underscores (“next payment” matches `next_payment`). A list of
plain strings (a `read multiple`) is treated as records with one key, `value`,
so `Verify every value in {{statuses}} is "Overdue"` works on a flat read.

**Normalisation.** Cell text is what the page rendered, which is not what a
comparison wants. The number and date parsing behind the last two forms — and
the “add up to” total — must handle: currency symbols and thousands separators
(`$1,234.56`); a leading `+`; the Unicode minus `−` (U+2212), which the
transactions fixture uses and which `Number()` rejects; parentheses for
negatives; and dates in `25 Mar 2026`, ISO, and `dd/mm/yyyy` forms, the last
under the project's locale setting rather than a guess. A value that does not
parse fails the assertion and names the row and the text, rather than sorting
as a string. Tools that do their own arithmetic over records (the
`[tool: sum_column …]` workaround) should be pointed at the same helper.

Where the same assertion is written in prose without a `{{list}}` — “verify
every row in the table shows Completed” — it remains a model assertion over
the snapshot, with the collapse caveat of §4.9. The handbook should say which
form is which.

### 7.9 Grids with no `<table>`: the ARIA table model

A `div` grid is a table in everything but tag names, and the ARIA attributes
that make it one for a screen reader make it one here (§5.8, measured on
MUI DataGrid; ag-Grid from its documentation). Read as a table when the
matched element, or the one such thing under a wrapper, carries
`role="grid"`, `role="table"` or `role="treegrid"`:

- **Rows** are the descendants with `role="row"` whose nearest
  grid/table/treegrid ancestor is this element (a nested grid's rows are its
  own). **Cells** are a row's element children with `role="columnheader"`,
  `"rowheader"`, `"gridcell"` or `"cell"`; children with `role="none"` or
  `"presentation"` (MUI's filler) and children with no role are skipped.
  `role` is an attribute of whitespace-separated TOKENS, and the first token
  is the role: `role="row presentation"` is a row and `role="gridcell "` is a
  cell. Measured against the whole attribute string: both were dropped
  silently — the row vanished from the read, the grid came back one record
  short, and nothing said so.
- **Header rows** are rows that hold at least one `columnheader` and no
  `gridcell`/`cell`. Several header rows form the header grid of §7.3b, with
  `aria-colindex`, `aria-colspan` and `aria-rowspan` in place of the table
  attributes; a cell without `aria-colindex` takes the next free column.
  Rows before the first header row that hold only `columnheader`s are part
  of it; a header row after data rows is not a header.
- **Data rows** are the rows holding at least one `gridcell`/`cell`. The
  §4.8 rule reads `aria-colspan` for its lone-spanning-cell test, and a row
  with no cells is skipped and counted, as for a table.
- **Position** of a cell is its `aria-colindex` when present (one-based),
  else its order among the row's cells. Width is the header grid's.
- **Fragments.** Rows with the same `aria-rowindex` (or, failing that, the
  same `row-index`) inside one grid are ONE row whose cells are merged by
  position: ag-Grid's pinned containers repeat a row's first cells beside
  the rest. Without either attribute, each `role="row"` is its own row.
- **`_row`** is the one-based position among data rows in document order of
  their first fragment — not `aria-rowindex`, which counts the header and,
  in a virtualised grid, rows that are not in the DOM.
- **Rendered** rows and cells are decided as for a table (§7.4). A
  virtualised grid yields only the rows it has rendered (§10), as before.
- **Label** is the grid's `aria-label`, then the text `aria-labelledby`
  names, then its `id`, then the selector.
- **The sentences** are the table ones. "found no table with rows under"
  now means no `<table>` and no ARIA grid with data rows under the wrapper.

A `<table>` under a wrapper wins over an ARIA grid under it when both exist
with data rows only if they are the same element (a `<table role="grid">`
is read as a table); otherwise that is two things with rows and is refused:
`readTable found a table and an ARIA grid with rows under "<selector>" — it must be exactly one, so select the one you mean`,
and two grids `readTable found <n> ARIA grids with rows under "<selector>" — it must be exactly one, so select the one you mean`.

Five refinements, each measured on the way in:

- An element is an ARIA grid only when it OWNS `role="row"` descendants.
  Kendo's wrapper is `<div class="k-grid" role="grid" aria-label="Dividends">`
  with native `<table>` markup inside and not one `role="row"` of its own;
  read as a grid on the strength of the attribute it answered `[]`, green.
  Whatever it calls itself, an element with no rows of its own is a wrapper
  (§7.2).
- A row belongs to its nearest table OR grid host. Kendo writes `role="row"`
  on its `<tr>`s, and those rows answered to the wrapper two levels up; a
  `<tr>` belongs to its `<table>`, and nothing above the table can claim it.
- A header row AFTER data rows is excluded, as a `<tfoot>` is (§7.4) — not
  demoted to a record of heading text.
- A lone ARIA grid with no data rows under a wrapper that holds no `<table>`
  at all reads `[]`, as an empty table does (§4.8): an author who filtered
  every row out of a MUI grid gets an empty list, not a broken step.
- Fragment keys are namespaced: rows merge by `aria-rowindex` with rows that
  carry `aria-rowindex`, and by `row-index` with rows that carry `row-index`,
  never across the two; where two fragments claim the same position the
  first wins. A row whose only cells are `rowheader`s stays in the body (§10:
  a row header is that row's cell at its position); only a row with no cells
  is skipped and counted.

### 7.10 When structure cannot decide: the model names the parts, once

Everything above is structural and free. What is left is the long tail —
headings written as `<td>`, a header table after the rows, card lists,
key/value tables per record, widgets nobody has measured — and it is read
by asking the model ONE question about structure, validating the answer
against the page, and then reading deterministically, on this run and on
every run after.

**When.** Only when a read fails for a SHAPE reason: no table or grid with
data rows under the matched element (§7.2); two or more with data rows
(frozen columns, or two grids in one box); header names requested and no
header found — no header row, a header grid naming nothing, no header table
paired (§7.3, §7.3a, §7.3b); two header-only candidates or a width mismatch
in the pairing (§7.3a). NEVER for the author's own problems: a named header
absent from a header that exists (typo), a short row, a merged body cell,
more than 500 rows, a selector matching several elements. Those stay
refusals with the sentence they have.

**The sketch.** The extractor returns, beside the refusal, a sketch of the
region: for a region holding tables or grids, each candidate with an index
(`T1`, `T2`, …), a selector the runtime derived (`#id` when it has one, else
a path relative to the matched element), and its rows summarised — section,
cell count, tags or roles, spans, and the first cells' text — capped at a few
kilobytes; for a region with no table or grid, the cleaned DOM snapshot of the
matched element alone (the existing capture, rooted there), capped the same
way.

**Everything in the sketch is masked with the run's secret set, exactly as
the DOM snapshot is** (§7.6): the candidates' cell text, the region snapshot,
and the `Selector:` line of the question — which is the author's own selector
and can carry a value as readily as a cell can. Measured with the masking on
the cells alone: a card list whose fields held a secret reached the prompt,
and the recorded interaction in the report, verbatim.

**The region snapshot is carried INSIDE the sketch JSON, as a string**, never
pasted raw into the message beside it. A JSON string has no line starts and
no terminator a page can spell; markup dropped between the delimiters does.
Measured: a text node reading `--- END SKETCH ---` survived the clean and
came out at the start of a line, ending the data block early and leaving the
rest of the page where the instructions are. The sketch is data from the
page: it reaches the model as such and never as instructions.

**At most eight rows per candidate** are listed, the rest counted in
`moreRows` — and fewer as the sketch is shrunk to fit its byte budget, since
rows are given up before candidates are: the SHAPE of the region is what the
question is about. So a heading row below the eighth cannot be named at all.
The model may answer only from what the sketch lists (R1), so a table whose
headings sit under nine rows of preamble gets `none`, or a wrong row, rather
than the right one. Nothing has needed more yet; §14 carries it as a
follow-up.

**The question.** `buildGridStructurePrompt` (`src/ai/prompts.ts`) shows
the sketch, the author's request (the columns wanted, by header or by
position) and the refusal, and asks for one JSON answer of three kinds:

```json
{ "kind": "table", "rows": "T2", "header": { "table": "T1", "row": 2 } }
{ "kind": "collection", "item": ".account-card", "fields": { "account": ".card-title", "balance": ".field:nth-child(1) .value" } }
{ "kind": "none", "reason": "the element is a navigation menu, not a list of records" }
```

`header` is omitted for a positional request, and `header.row` may be
omitted as well when the candidate it names HAS header rows of its own — a
header-only table's `<thead>`, an ARIA grid's header row — because there is
then nothing to choose between and the header grid of §7.3b is the answer.
`item` is a CSS selector
relative to the region; each field selector is relative to the item. Every
selector is PLAIN CSS — what `querySelectorAll` accepts — never a Playwright
pseudo-class (`:has-text()`, `:text-is()`, `:visible`): validation and
extraction both run in the page, where such a selector throws rather than
misses. Structural selectors inside an item (`:nth-child`, `+`, `>`) are
fine, because the item is the record boundary. The prompt's rules, pinned
by `tests/prompts-grid-structure.test.ts`: answer from the sketch only,
never invent a table or a cell; the rows table is the one whose rows carry
the values the author asked for; the header row is the one whose cells are
the names the author used; a collection's item is the repeated element, one
per record; fields are relative to the item and match at most one element
in it; plain CSS only; answer `none` when the region is not a list of
records, and say why; JSON only. The sketch reaches the model inside a
delimited block headed as data, not instructions.

**Sections, and what "row 2" resolves to.** Every row the sketch lists
carries a `section`: `thead`, `tbody` or `tfoot` for a `<table>`, and
`header` or `row` for an ARIA grid — a grid has no element saying which, so
the split of §7.9 decides it. The model answers with the row's position among
the rows the sketch listed for that candidate (row id `T1.r2` is row 2), and
the runtime converts that to the mapping's `bodyRow`: a `thead` (or
`header`) answer resolves to the candidate's own header grid, whichever of
its rows was named, while a `tbody` or `row` answer becomes the k-th BODY
row of that candidate, **counted among body rows only**. Measured counting among ALL of the candidate's rows: on a
grid whose header row is row 1, a correct answer of "row 2" — the first data
row, which is exactly where a `<td>`-headed grid keeps its headings —
pointed one row too low, took a data row as the header and spliced it out of
the read. A `tfoot` row is refused as a header: a totals row is not a
heading row, and §7.4 excludes `<tfoot>` from the body, so the row named
would not be there to splice out anyway.

Mapping selectors resolve against the **mapping root**: the region itself
when the region is a wrapper, and, when the region is a `<table>`, the
nearest ancestor below `<body>` that holds another table or grid — the same
root the sketch's candidates were listed from, because a table's partner
sits beside it and `querySelector` cannot reach out of its own root.
`:scope` in a mapping means that root.

**Validation**, all of it deterministic and all of it required, or the step
fails with the model's answer and what was wrong with it:

- *table*: `rows` and `header.table` name candidates the sketch listed.
  Resolved against the mapping root, each of `rows` and `header.selector`
  must land on the region itself, on something inside it, or on one of the
  candidates the sketch listed FOR that region; anything else is refused —
  `… the rows selector "<sel>" is not the selected element nor one of the
  tables beside it`. Measured without that check: a mapping naming an
  unrelated `#payroll` table that happened to sit beside the region was
  applied as given, and the read came back holding the payroll table's rows
  under the author's own selector. Reading a table that is not the region —
  the legitimate case, a header table or a rows table BESIDE it — is allowed
  and logged at warn, because the only thing making it right is a model's
  answer. Then: the rows table has at least one data row (§7.4); the header
  row's grid (§7.3b) names at least one column; the widths agree; every
  requested header resolves, and every requested position is within the
  width. A `bodyRow` that is HIDDEN, or that §4.8 reads as a message row or
  §7.4 as a detail row, is refused as the header rather than promoted out of
  the body: measured, a `display:none` first row and a "No records"
  placeholder were both accepted, the first naming every column from markup
  nobody can see and the second naming one column `No records`.
- *collection*: the item selector matches at least one and at most 500
  elements under the region, none nested inside another match; each field
  selector matches at most one element inside each item; every requested
  key has a field; a field that matches in no item at all fails the read,
  one that matches in some reads `""` in the others and is counted in the
  log line.
- *none*: the read fails with the model's reason after the original
  refusal.

**Extraction.** *table*: the ordinary extractor, with the two tables pinned
by an internal `mapping` argument rather than searched for — §7.3b, §7.4,
§4.8 and `_row` apply unchanged. *collection*: one record per rendered
item in document order, `_row` first, each field the rendered text of its
element (§7.4's text rule), `""` when the field is absent from that item.

**Caching.** Within one run, a validated mapping is remembered in a **memo**
(`src/runner/structure-memo.ts`), so a later step that reads the same region —
the next page of a legacy table in a `While` loop, a second read after an
action — reuses it (validated against the page as always) and logs
`structure reused from step N` instead of asking; measured before the memo,
the repeat read at the end of `table-odd-shapes.md` asked the same question
its first read had, and the file's four shapes cost five questions.

The memo's **key** is the frame, the selector, and the requested columns
sorted — each column by its header or its position AND by its output key.
The key is what a mapping was validated against: a `table` answer resolved
every requested header against the header row it named, and a `collection`
answer carries one field selector per requested key, so the same cards read
for `account, balance` and later for `account, owner` are two structures and
reusing the first would read a column the model never chose a selector for.
`Payee → payee` and `Payee → who` want the same table and different
`fields`, which is why the output key is in the key too. Sorted, because the
order of the columns changes the record's property order and nothing about
the structure.

The memo's **lifetime is one run**, and each runner draws that line where its
own run ends:

- the CLI makes one per `runTest`, which is one per **data row** — a row
  that navigates somewhere else should not start out holding the previous
  row's answers;
- the server makes one per **batch**, the lifetime `stepCache` already has:
  a batch is what the server knows about, and a run split by a breakpoint or
  an `[input:]` simply asks once more on the far side rather than reusing an
  answer from before a pause the user may have spent editing the page;
- the errand runner (`src/server/errand-runner.ts`) and the Electron runner
  (`src/ui/main/runner-adapter.ts`) each make one per run;
- hook steps share the test's memo: a `beforeEach` that reads the same
  region as the step after it pays for one question between them, not two;
- a caller that keeps no run state at all — the REPL — passes none and
  behaves as it did before the memo existed: one question per step.

The memo is deliberately **not gated by the step cache**. That switch is
about replaying a frozen action plan; this is about not asking the same
structural question twice in one run, and the two do not answer to each
other. A run with the cache off still asks once — and a loop body, which
never uses the cache at all, is precisely the shape the memo exists for: a
`While` that re-reads one legacy table every pass asks on the first pass and
on no other.

Across runs, the validated mapping is written onto the cached `readTable`
action as `mapping` — a field the RUNTIME owns: the parser strips it from
anything the model emits, the step cache stores it, the report shows it.
A cached run applies the mapping first and validates it against the page
as above (the header texts are still there, the counts agree, the item
selector still matches). When that fails, the read is first repeated
WITHOUT the mapping — free, no model call — and if that succeeds the
mapping was simply no longer needed and is dropped from the cache; if it
fails too, the question is asked ONCE more, the cache rewritten with the new
answer, and a second failure is the refusal with both answers in the log.
That second question is asked from a **fresh sketch of the region**
(`sketchTable`, `src/browser/actions.ts`) rather than from the re-read's
refusal, because the re-read need not have failed for a shape reason at all:
a mapping that no longer fits can leave the unmapped read failing for any
reason the page now has, and a refusal that is not a shape one carries no
sketch. Sketching the region again is what keeps "asked once more" true in
the case the sentence was written for. Every failure that follows a question is
non-retryable: retried, a failing cached replay would be invalidated and
re-run under AI, asking the same question a second and a third time, and
the "both answers" sentence would be lost with the cache that held the
first. Code-behind: readTable stays an AI-only framework
action (§9.2); the mapping rides in the cache until phase 3's `tables.read`
writes it into the generated call.

**Log and report.** Four lines at info, quoted here because they are what a
reader greps for (`src/runner/step-executor.ts`):

```text
readTable: structure asked of the model — <summary>
readTable: structure reused from step N
readTable: the read failed for a shape reason and `tableStructure: strict` is set, so the model was not asked about the structure.
readTable: the cached structure mapping is no longer needed — the page's own structure decides it now, so the mapping has been dropped from the cache.
```

An answer of `none` writes the first of them as
`readTable: structure asked of the model — it answered none: <reason>`.

The read's own summary line (§7.6) then says where the structure came from,
as its last parenthesised note — `structure from the model: …` when this
step asked, `structure from the run: …` when the memo answered, and
`structure from the cache: …` when the cached mapping did, so a green read
says which of the three paid for it. That phrase leads a TABLE mapping,
and what follows names each candidate by the id the model used AND by its
selector, because the id alone means nothing once the sketch has scrolled
out of the log. A COLLECTION's note is the bare `collection: ` form — the
item count and selector, with the missing-field count after it — and the
source is on the info line above it (`structure asked of the model — …` /
`structure reused from step N`):

```text
readTable captured 12 rows × 3 columns as "{{accounts}}" (structure from the model: rows in T1 ("#rows"), header row 1 of T1 (":scope"))
readTable captured 5 rows × 3 columns as "{{cards}}" (collection: 5 items by ".account-card"; 2 items missing balance)
```

The sketch, the question and the answer go to the debug log; the report's
action carries `mapping`.

**Cost and control.** One model call per structure per run, and none on a
cached run. `## Config` `tableStructure: strict` (and `"tables": { "structure": "strict" }` in
`aiui.config.json`) turns the question off for a test or a project, so a
run that must be deterministic gets the refusal instead. TestBench's own
client does not forward `tableStructure` (its per-session config carries
`baseUrl`, `timeout` and `viewport`, as it does not forward `unmask`, §14);
a test run from TestBench takes the project's `aiui.config.json` value.

---

## 8. Object-aware `For each`

### 8.1 Stored representation

`readTable` stores the array as JSON in the existing string-valued map:

```text
orders = [{"id":"ORD-1001","customer":"Alice Smith","status":"Completed"}]
```

`parseListValue` continues to require a JSON array. Existing arrays of strings,
numbers, booleans, and null keep their present behavior.

### 8.2 Bindings for an object item

For:

```markdown
For each {{order}} in {{orders}}, Check the order
```

and item:

```json
{ "_row": "1", "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" }
```

the pass binds:

```text
order          = {"_row":"1","id":"ORD-1001","customer":"Alice Smith","status":"Completed"}
order._row     = 1
order.id       = ORD-1001
order.customer = Alice Smith
order.status   = Completed
```

`_row` is an ordinary property here: a record from a tool or an API that has
no `_row` simply has no `{{order._row}}` binding, and a step that uses one
fails as any missing dotted binding does (§8.3).

The base binding preserves current behavior for non-string array elements. Each
direct property becomes a dotted binding. Property conversion is:

- string -> unchanged;
- number/boolean -> JSON lexical form (`42`, `true`);
- null -> `null`;
- object/array -> compact JSON text.

Only one direct property segment is addressable in v1. `{{order.address.city}}`
is not supported.

A key no placeholder can spell — one that fails the property-segment rule of
§8.3 (`content-type`, `Order ID`, `total-amount`) or is one of the three
prototype names (`__proto__`, `prototype`, `constructor`) — is **dropped,
not bound, and never fails the guard**. A list that reaches `For each` from a
tool or an API is not the author's to rename, and a test that only uses
`{{item}}` as JSON text must keep running as it did before this feature (§2).
The dropped keys are reported once per loop entry, at info level, redacted,
naming the loop's item:

```text
For each {{order}}: 2 properties cannot be referenced as placeholders (content-type, Order ID)
For each {{order}}: 1 property cannot be referenced as a placeholder (content-type)
```

The spellable keys of the same record bind normally. What does fail the guard
is an item that is not a record where a record was expected, or a list that
does not parse; that failure names the one-based item index and binds
nothing of that item.

As with the current scalar item binding, values from the last completed pass
remain in the one live variable map after the loop. This includes dotted
bindings. Do not introduce snapshot/restore semantics only for objects.

But a pass binds its root **fresh**: before a pass's bindings are applied,
every existing `root.<property>` key for that root is removed, in all three
run loops through one shared helper. Without that removal a pass whose record
lacks a property reads the previous pass's value for it — `{{row.note}}` on
row 2 saying `first` — and the §8.3 refusal can never fire; the same leak
crosses two loops that share an item name, and a loop over records followed
by one over strings. Lingering *after* a loop is licensed; one pass reading
another's field is not. The `For each` cursor carries the records' properties
through every rebuild, the Electron debugger's jump-to-step (`planForStart`)
included: a rebuild that drops them binds no property on any later pass.

### 8.3 Placeholder grammar

Extend runtime references from:

```text
{{name}}
```

to:

```text
{{name}}
{{name.property}}
```

with no whitespace — and for the dotted form that is enforced, not assumed:
`{{ order.id }}` is refused before the model call with the spelling it
should have had (`{{order.id}}`), whether or not the name resolves, because
a dotted reference the narrow grammar leaves literal would otherwise reach
the model as six braces (the flat `{{ name }}` keeps whatever it has always
done). The property segment is `[A-Za-z_][A-Za-z0-9_]*`. The
root segment stays what it has always been, `\w+`: tightening it would
change what `{{1st}}` means for existing tests (`runner-core/src/data-rows.ts`
documents that looseness as deliberate), and nothing accepted a dotted name
before, so only the new segment gets the identifier rule. As built, the one
definition is `PLACEHOLDER_SOURCE` in `src/parser/parameters.ts`, imported by
every copy in `src/` and mirrored — with a parity test — in TestBench.

All copies of the grammar must change together, including at least:

- `src/parser/parameters.ts`;
- `src/runner/placeholder-substitution.ts`;
- `src/skills/expander.ts`;
- placeholder accounting/leak checks in `src/codebehind/generate.ts`;
- TestBench completion/definition hit tests in
  `testbench-native/src/extension/env-data-completion-core.ts` and
  `env-data-definition-core.ts`;
- any runner-core mirror which classifies or reports runtime placeholders.

Prefer a shared exported regex/source where dependency boundaries allow it;
where a mirror is required, add a parity test as the repository already does
for control-line and step-line grammars.

A missing dotted binding is new syntax with no legacy fallback. Fail before an
AI call with an error such as:

```text
{{order.statuz}} has no value in For each item 2; available properties are _row, id, customer, status
```

`_row` is listed because it is bound: hiding a property that works would
send the author hunting for a typo in a working name. Keys the record has
but no placeholder can spell (§8.2) are named beside the ones that work, so
an author who tried `{{order.contenttype}}` learns why it is not there:

```text
{{order.contenttype}} has no value in For each item 1; available properties are id, status (content-type cannot be spelled as a placeholder)
{{order.contenttype}} has no value; {{order}} has no properties that can be spelled as placeholders (content-type)
```

Do not pass the literal braces to the model. Existing unresolved flat-name
compatibility is outside this feature and remains unchanged.

**Empty values.** An empty cell is stored as `""` (§7.4), and a binding of
`""` substitutes to nothing. Where that matters is a *step* whose check is
entirely between values: the model is shown the authored line with a values
block, classifies it as a self-contained predicate, and copies the condition
into the check *as written*, placeholders included; the framework then
substitutes just before the check is generated, and `Verify that
{{payment.reference}} is empty` becomes `is empty` — a comparison with
nothing on its left, and not the question you asked. Authors quote a
placeholder that can be empty in a `Verify` or `Assert` line — `Verify that
"{{payment.reference}}" is empty` becomes `"" is empty` — and the handbook
says so beside the first dotted example. A *condition* is different: the
judge is never shown a substituted condition at all (it receives the authored
line and a values block), and under §8.3a a condition on captured values is
decided by the runtime, which quotes substituted values itself, so `If
{{payment.reference}} is empty` is decided correctly quoted or not. Whether
the runtime should also render an empty binding as `""` in a step is an
open question (§14); v1 does not, because a `Type {{payment.reference}}
into the field` that typed two quote marks would be worse than a check that
reads oddly.

Two rules on the same theme, both phase 1. The assert parser requires
`expected` to be a **string**, not a non-empty one: `"expected": ""` is a
DOM assertion whose right answer is an empty cell (`Verify the Reference cell
in row 2 … is empty`), and reading it as a missing field fails the parse
exactly when the model answered correctly. And the prompt tells the model to
keep the two quote marks as the left operand when a predicate's substituted
value is empty, so the check reads `"" is empty` rather than losing its
operand.

### 8.3a Conditions on captured values are decided without the judge

Every dotted-binding condition in this document — `If {{payment.status}} is
"Paused", then return`, `If "{{payment.reference}}" is empty, then …` — is,
after substitution, a comparison of literals: `"Paused" is "Paused"`,
`"" is empty`. The control-flow story's judge exists to decide page
conditions from a snapshot, and asking it to compare two strings is both a
model call per pass that buys nothing and, as the acceptance runs measured,
a source of wrong answers: on `"" is empty` the judge once replied *"the
visible statement row being evaluated has debit −$65.00, so it is not
empty"* — it went to the page for a fact that was in the text, found a
different row, and sent the loop down the wrong branch. The same shape had
been judged right fourteen times before that.

So the runtime decides such conditions itself. A condition is a candidate
only if the **authored** line contains at least one `{{…}}` or `${…}`
reference — a condition with no placeholder, `If "Welcome back" is empty`,
is about the page however literal it looks, and goes to the judge — a
`Repeat … until "Load more" is empty` decided from its own text would run to
its cap. Each bound reference is substituted as a **quoted** literal unless
the author already put it in quotes, so `If {{payment.status}} is "Paused"`
becomes `"Overdue" is "Paused"` and `If "{{line.debit}}" is empty` becomes
`"" is empty` — **both** decided locally, since accepting only the quoted
spelling would leave this feature's own examples paying a judge call per
pass. A value that itself contains a
double quote cannot be spelled as a literal — the grammar has no escape
syntax, on purpose, so that nothing widens what an *authored* condition
parses as — and a condition holding one goes to the judge as before. The
bindings are applied by one shared helper in `control-runtime.ts`, the
impure half the three loops already share.
If the whole substituted text then matches the grammar below it is decided
with no model call, and its guard row carries the reasoning `decided from
the values: "Overdue" is "Paused" → false` in place of the judge's sentence,
with secret values redacted before it reaches the log or the wire; anything
else goes to the judge exactly as before. A value is a double-quoted string
or a bare number. The equality family (`is`, `equals`, `is not`, `does not
equal`, `is different from`) compares strings **exactly** — `"0012" is "12"`
is false, because zero-padded ids and money strings are what a table read
yields and review found numeric coercion calling them equal — and only the
ordering family is numeric, and only when both sides are plain numbers **once
the quotes are off**: the test is applied to the operand's value, so `"5" is
at least 10` is decided locally. Otherwise the ordering goes to the judge, and
that is the quiet case an author meets — `"$140.00" is more than 100`, or any
comparison of dates, is a model call nothing warns about (§7.7's normaliser is
phase 2).

```text
<v> is empty | is blank | is not empty | is not blank
<v> is <v> | equals <v> | is not <v> | does not equal <v> | is different from <v>
<v> contains <v> | does not contain <v> | starts with <v> | ends with <v>
<v> is at least <n> | is at most <n> | is more than <n> | is greater than <n> | is less than <n>
```

A chain (`If` / `Else if` / `Otherwise`) is decided locally only when every
member's condition is literal; if any member needs the page, the whole chain
goes to the judge, so one evaluation never mixes the two sources. `While`
and `Repeat … until` conditions get the same treatment on every evaluation,
and so do the flow-control lines of the step-flow-control story — `If …,
then return`, `then stop`, `then fail the test with error "…"` — which are
claimed before the chain grammar and judged on their own path in the step
executor, so a rule written for the chains alone would miss them — and the
very line this section opens with is one of them.
`When prompted …, then return` is a watch, and stays with the judge.
The grammar lives in one exported parser beside `set-step.ts` and
`flow-control-step.ts` (`src/parser/literal-condition.ts`) so the handbook
can name it and TestBench can one day show it on hover. Anything with prose
in it — `the Cash checkbox is ticked`, `"a" is "a" and "b" is "b"` — is not
literal and is judged. A condition in which a placeholder survived
substitution (`{{` or `${` still present) is never literal either: the
substituter leaves what it cannot answer as written, and `"{{order.missing}}"
is empty` would otherwise parse as a non-empty string and answer `false`
with confidence.

The §8.3 refusal covers guard lines as well as steps: a dotted reference the
pass cannot answer inside an `If`, `Else if`, `While` or `Repeat … until`
condition fails the guard before the local decision and before the judge,
with the same message, in all three run loops — one bad member refuses the
whole chain, because the judge is asked one question about every member.
And the `For each` header's own item name is a definition, not a reference:
the loops that interpolate a line before dispatching it no longer log
`Unresolved placeholder: {{payment}}` against `For each {{payment}} in
{{payments}}` (`controlLineDefines` in `src/parser/control-line.ts` names
what a control line writes). The exemption is by **root**, so it covers the
item's properties too: a plain tail such as `For each {{order}} in
{{orders}}, Click the row whose Order ID is "{{order.id}}"` (§4.6's own
example) logs nothing on entry, while `{{other.id}}` on the same line, a
root no loop binds, still warns.

### 8.4 Loop reporting and TestBench

- Loop markers and `frame:scope` must include the dotted property bindings so
  the TestBench Variables panel can show the current row fields — and
  `frame:scope` must say WHICH of its dotted names those are, in a
  `bindings: string[]` beside the scope (§7.6). The scope is a copy, and whose
  a dotted name is lives in a registry keyed on the server's live map, so
  without that list the client cannot tell `payment.keyword` from a data
  file's own `user.apikey` heading and masks one of them wrongly whichever
  rule it picks. Every `frame:scope` carries it, empty list included; the
  run's `## Config: unmask:` names ride the same event as `unmask: string[]`
  when it has any.
- Secret masking applies using the property segment, by the rules of §7.6:
  the property decides by the record-column rule, the root by the
  author-chosen one, and the whole name read as one credential key with the
  dots as separators (`api.key` → `api_key`, §7.6) decides it as well — any
  of the three is enough. (Testing the whole dotted name with the AUTHOR
  rule is the bug the first two replaced: `row.keyword` matched on `key` and
  masked every "AU" in the log, the report and the DOM snapshot. The third
  clause is the RECORD rule reading the joined name, which is why
  `row.keyword` and `payment.sort_key` stay clear of it.)
- The whole-record binding (`payment`) and the capture it came from
  (`payments`) are masked by looking INSIDE them — each secret column
  replaced, the rest left readable. Nothing about either name says secret, so
  without that they rendered a password in full directly above a
  `payment.password` row showing `********`.
- `_row` leads the properties in that view, which needs saying because a
  plain sort does not do it: `_` is code unit 95, between the upper-case
  letters and the lower-case ones, so an `Amount` alias came out first.
- TestBench must recognize a dotted reference as one token rather than treating
  `{{order}}` as a partial token followed by text.
- Minimum v1 editor behavior: no false diagnostic and correct hover/runtime
  value while running.
- Property completion after `{{order.` is desirable but not required because
  the aliases originate in a natural-language read step. If implemented, it
  must derive only explicit `as <key>` aliases plus `_row`, and must not guess
  from prose.
- Go-to-definition for `{{order.id}}`, if offered, should target the `For each`
  line; field-level definition navigation is not required.

---

## 9. Code-behind and cache behavior

### 9.1 Cached AI actions

A cached `readTable` plan must execute against the current DOM and capture fresh
records, exactly as a cached `read multiple` action does. Cache only the action
shape (`selector`, headers or indexes, keys, modes, and optional `limit`),
never captured row data.

Placeholder substitution must walk header strings if an author parameterized a
header name, while `columns[].key` remains a definition/name and must never be
substituted.

### 9.2 Generated code-behind

`readTable` is deterministic and should compile. Do not add it permanently to
`FRAMEWORK_ACTIONS` as an AI-only action.

Expose one shared table reader to generated entries rather than asking the
code-generation model to reinvent header mapping. A recommended context shape:

```ts
async run({ page, step, tables }) {
  const rows = await tables.read(page, {
    selector: 'table[aria-label="Orders"]',
    columns: [
      { header: 'Order ID', key: 'id' },
      { header: 'Customer', key: 'customer' },
      { index: 5, key: 'status' },
    ],
    limit: 10,
  });
  step.setVar('orders', JSON.stringify(rows));
}
```

`tables.read` and the AI action must call the same underlying extraction helper.
There must not be one header algorithm in generated code and another in
`actions.ts`. Positional columns, `_row`, the placeholder-row rule and the
optional `limit` must have identical validation and visible-row semantics in
both paths.

Update the code-generation prompt, context types, undeclared-context static
check, review prompt, and repair prompt for `tables`. A compile/replay test must
prove that a reordered table still yields the same records without an AI call.

### 9.3 Captures and output accounting

The existing `[store as: orders]`/capture accounting must recognize that the
step writes `orders`. Generated code writes the compact JSON string through
`step.setVar`; later `For each` parses it. Placeholder leak checks must treat
`{{order.id}}` as a reference to the dotted runtime binding, not as an unknown
root or a literal value that can be inlined into generated source.

---

## 10. Edge cases and required decisions

| Case | Required behavior |
| --- | --- |
| Checkbox is the first column | Ignored unless requested; requested headers map independently of position. |
| No `data-*` attributes | Supported; header mapping and visible text are sufficient. |
| Columns reordered | Supported with no test change. |
| Header capitalization/extra whitespace changes | Supported through normalized exact matching. |
| Header renamed (`Order ID` -> `Order number`) | Fail missing header; do not fuzzy-match. |
| Duplicate `Status` headers | Fail ambiguous header and list matching indexes. |
| Empty checkbox header | Allowed and ignored. |
| Empty requested cell | Preserve `""`; do not drop row or value. |
| Row has too few cells | Fail the whole read, naming `_row` and the header or position. |
| Hidden filtered row | Excluded before applying `limit`; it does not consume one of the N slots. |
| Hidden requested column | Cells remain structurally aligned; rendered text is empty, so store `""` for that field. |
| Nested table inside a cell | Nested rows/cells are excluded from both header and body scans. |
| Multiple `<tbody>` elements | Include their visible direct rows in DOM order. |
| `<tfoot>` totals row | Excluded. |
| Row-header `<th scope="row">` in body | Counts as that row's cell at its logical position. |
| `rowspan`/`colspan` > 1 in a selected row | Fail as unsupported in v1, unless the row is a placeholder (below). |
| `rowspan="0"` (“to the end of this row group”) | A merged cell. The DOM reports it as `0`, so the test is `rowSpan !== 1`, not `> 1`. |
| Placeholder row: one cell with `colspan` ≥ max(table width, 2) | Not data. Alone in the body: store `[]`. Among data rows: skipped, no `_row` consumed. Logged as “N placeholder row(s) skipped”. Classified before the merged-cell rejection. |
| Body row with no cells at all | Skipped and counted as a placeholder; nothing to map, nothing to number. |
| Table width, with no header row | The widest body row's cell count over **all** body rows, rendered or not — a table whose only rendered row is the full-width message would otherwise measure one column wide and fail as a merged cell instead of storing `[]`. |
| One-column table, with or without a header | Its ordinary (`colspan="1"`) rows are data; the floor of 2 in the rule above is what keeps them out of it. |
| One-column table with a lone `colspan="2"` message row | A placeholder, not a merged-cell error: a cell spanning more than its own column is a message. |
| One-cell `<th>` row above a wider heading row (`<tr><th>Section A</th></tr>`, then `<tr><th>Name</th><th>Status</th></tr>`) | A group heading, stepped over by the header search (§7.3); the wider row is the header. The group row stays in the body as data: record 1 for a one-column read, the short-row refusal for a wider one. |
| One-cell `<th>` row with NO wider heading row below it | The header, however wide the data rows are (§7.4). |
| `<thead></thead>` present but empty, headings in the first `<tbody>` row | The body-row header rule applies (§7.3); an element-presence test read the table as headerless. |
| `display:none` template row before the headings | Skipped when looking for the header row: the first body row that is rendered **or** carries a `<th>` is the one considered, and only that one. |
| Header row mixing `<td>` and `<th>` (checkbox cell beside headings), no `<thead>` | The header row (§7.3); never record 1. |
| CSS-grid table (`tr`/`td` with `display: contents`) | Reads normally: a `display:contents` row or cell is rendered if its content is. |
| Rows appended directly under `<table>` (no `<tbody>`) | Read as body rows. |
| “Loading…” row | A placeholder; the read stores `[]` truthfully. Waiting is the author's step, before the read. |
| A `colspan` narrower than the table | Still the §7.4 merged-cell error. |
| Group row with one spanning cell and hidden filler cells (Kendo) | A placeholder (§4.8): the only rendered cell spans the width. Skipped, counted, no `_row`. |
| Detail row under an expanded record: an expand cell beside one `colspan` cell (RadGrid, Kendo, DevExpress) | At least two cells short of the width, with spans that cover it: skipped and counted with the placeholders (§7.4), before numbering and before `limit`; its nested table is not read. |
| A row ONE cell short of the width whose spans cover it (`<td>a</td><td colspan="2">b</td>` at width three) | Not a detail row: indistinguishable from a merged data row, and still the merged-cell refusal (§7.4). |
| Data row with a `rowspan` cell | Still refused: it shifts the rows below. |
| Data row as wide as the grid with a `colspan` cell | Still refused: wider than the grid. |
| `aria-owns` naming the table's OWN `<thead>` (RadGrid's non-scrolling form) | Not a declaration; the table reads by its own header grid. |
| `aria-owns` with a trailing space | Tokens split on whitespace; empty tokens ignored. |
| Band and leaf with the same name after folding (`APPLICANT` over `APPLICANT`) | The leaf matches; bands are consulted only when no leaf does. |
| A rendered `<th>` whose only text is `display:none` (`ExpandColumn`) | Named by the hidden text, as an accessible name would be; listed among available headers. |
| Header in one `<table>`, rows in another, selector names the wrapper | Read as one table (§7.2): the one table with rows, its header from the one header-only table before it. Width mismatch refused with both counts. |
| The same, selector names the row table | The header is declared by the row table's `aria-owns`, or taken from the one header-only table beside it — before it, rendered, its header found, nested in no table, unnamed, with nothing but headerless tables between them — when the row table does not name itself and the widths match (§7.3a). Otherwise headerless, as before. |
| The same, selector names the header-only table | Refused, naming the wrapper (§7.3a). Never `[]`. |
| A header-only table with no rows anywhere near it | An empty table: `[]`, as before. |
| Split grid emptied to its "No records available." row | `[]` with one placeholder skipped: the width check ignores message rows (§7.3a). |
| Frozen grid whose unlocked row table declares its header (`aria-owns`) | Reads that half by header; a locked column is "no column is headed …" with the available headers listed (§7.3a). |
| Two separate tables, the first empty, the second headerless | Not paired when either names itself (`aria-label`, resolved `aria-labelledby`, `<caption>` text), when anything with text sits between them, or when their only common ancestor is `<body>`; the second stays headerless and the first reads `[]`. Named columns fail with the §5.4 message. |
| Two unnamed header-only tables above an unnamed headerless table, nothing but tables between them | Refused as frozen columns (§7.3a.2), by name and by position. Name either table, or put a heading between them, to read them as separate tables. |
| A header-only table with a two-row `<thead>` beside a plain headerless table | Paired like any other (§7.3b lays the rows out; no header shape is refused any more): the plain table reads by the leaf names. |
| Split grid emptied so that no table under the wrapper has a data row | The tables with any body row are considered, header-only ones excluded, preferring a declared (`aria-owns`) header, then `role="grid"`, then the rest; the first level holding exactly one wins and answers `[]` (§7.2). A RadGrid box emptied this way is otherwise "found 3 tables with rows" — its spacer and pager rows are body rows. |
| Filter cell holding a `<select>` whose option text renders | Names nothing: form-control text is not heading text (§7.3b). |
| Selected table names itself | Never paired and never refused: a whole table. A dangling `aria-labelledby` or an empty `<caption>` is not a name. |
| Header-only table whose only partner would be through `<body>` | An empty table: `[]`. `<body>` is never a grid container. |
| Header table of a frozen grid selected | Refused as the header row of a grid with frozen columns (§7.3a.3). Never `[]`. |
| Two tables in two cells of a layout table, or a table inside a header-only table's `<th>` | Never paired: a candidate nested inside any table is not one. |
| Frozen (locked) columns — two header tables and two row tables, no `aria-owns` | Wrapper: refused, two tables with rows. Either header table: refused as a frozen grid's header. Locked row table: refused, two header-only candidates. Unlocked row table: headerless — the §5.4 message by header, its own columns by position (§7.3a). Deferred (§14). |
| Wrapper holds a footer table too (`<tfoot>` only) | Ignored: neither rows nor a header. |
| Wrapper is a `<div role="grid">` of `<div role="row">`s | Read as a table by header name (§7.9). |
| `<div role="grid">` wrapper around a native `<table>` (Kendo) | A wrapper, not an ARIA grid: it owns no `role="row"` of its own (§7.9). |
| A `<tr role="row">` inside a `<table>` inside a `role="grid"` wrapper | Belongs to its table (§7.9). |
| ARIA header row after the data rows | Excluded like a `<tfoot>` (§7.9). |
| Lone ARIA grid with no data rows under a wrapper with no `<table>` | `[]` (§7.9). |
| A mapping selector using a Playwright pseudo-class | Refused as not a CSS selector (§7.10); the prompt forbids them. |
| Hidden column in a split grid | The header cell and the body cells are hidden together, so the counts still match and the column reads `""` as in one table. |
| Banded header: a band cell over several column names | Laid out (§7.3b); each column is named by the lowest heading over it; the band is not a column. Requesting the band fails naming the leaves under it. |
| Blank corner cell spanning two header rows (`<th rowspan="2"></th>`) | Occupies its column in both rows; the column is blank; the name row has one cell fewer than the grid is wide. |
| Filter row of inputs inside the `<thead>` | Laid out, names nothing, never data. |
| Same leaf name under two bands (`Q1 > Fee`, `Q2 > Fee`) | The plain name is the duplicate refusal with positions; `"Q1 > Fee"` picks the column by its band. |
| Leaf cell spanning two columns | Both columns get its name; requesting it is the duplicate refusal; a positional read works. |
| `<thead>` whose cells are all blank (RadGrid's data table) | No header of its own; §7.3a finds the real one (declared or beside). |
| Header-only table with a hidden spacer row in its body (RadGrid) | Still header-only: a lone spanning cell is a message row, not data. |
| Pager table whose one row is a lone spanning cell (RadGrid) | Neither rows nor header: ignored under the wrapper. |
| RadGrid box `#RadGrid1` | Reads: one table with data rows, header declared by its `aria-owns` (§5.7). |
| RadGrid data table `#RadGrid1_ctl00` | Reads by header (own blank `<thead>` ignored, `aria-owns` header) and by position. |
| RadGrid header table | Refused as the header-only pick, naming `#RadGrid1`. |
| RadGrid non-scrolling form (one table, three `<thead>` rows, pager in `<tfoot>`) | Reads with no pairing; the `<tfoot>` is excluded as always. |
| A `${item._row}` in an action field on a run with no environment | Refused before the action runs, naming `{{item._row}}`. |
| An element id built from `_row` (`#grid__{{item._row}}`) or from a literal "row N" | Forbidden by the prompt: ids are arbitrary (RadGrid's are zero-based); after a read the row is the table's own selector followed by `[data-aiui-row="N"]`, the scoping required because the bare attribute matches a row in every table read this run; with no stamp, counted among data rows. |
| `data-aiui-row` stamps after a read | Every data row of the read table, 1..N, equal to `_row`; none on header, filter, spacer, placeholder, detail or hidden rows; written only when the read SUCCEEDS, a refused read leaving the page untouched; a re-read renumbers and clears stale stamps from every descendant of that table, nested tables included; nothing outside the table touched. |
| No header row, columns named by header | Fail with the §5.4 message: name columns by position. |
| No header row, columns named by position | Supported; every column needs an explicit alias. |
| Header row present, columns named by position | Supported; the header is excluded from the body and otherwise ignored for those columns. Reordering breaks the read by design (§4.4). |
| `index` past the row's last cell | Fail like a missing cell, naming `_row` and the position. |
| `index` is zero, negative, fractional, a string, or above 100 | Parser rejection; never coerce. |
| A column with both `header` and `index`, or neither | Parser rejection. |
| Alias `_row` | Parser rejection; reserved. |
| `_row` | On every record, first, one-based among data rows after hidden and placeholder rows are excluded. Records from tools/APIs have it only if they wrote it. |
| Duplicate row identifiers | Extraction succeeds. A later action by value may be ambiguous; `{{item._row}}` names the row exactly (§4.5). `readTable` does not assume which field is a key. |
| Body changes during the loop (rows removed/reordered) | `_row` values captured earlier are positions and go stale from that pass on; documented in §4.5. Re-find by value or use `Repeat … until`. |
| More than 500 visible rows, no `limit` | Fail; never truncate implicitly. |
| More than 500 visible rows, with `limit` | Capture the first `limit` and succeed. |
| Fewer visible rows than `limit` | Capture them all and succeed; exact cardinality requires a separate assertion. |
| `limit` is zero, negative, fractional, a string, or greater than 500 | Parser rejection; never coerce or clamp. |
| Author asks for rows A through B, last N, row N onward, or disjoint ranges | Deferred (§14); prompt as unsupported, do not reinterpret. |
| Pagination plus `limit` | Apply `limit` to the currently rendered page on each invocation; never navigate automatically. |
| More than 20 requested columns | Parser rejection. |
| Empty table | Store `[]`; `For each` runs zero passes. |
| Virtualized table | Capture only currently rendered visible rows. No auto-scroll. |
| Table rerenders after capture | Loop uses the captured snapshot; later actions re-find rows and may fail honestly if a row vanished. |
| Icon/control-only requested cell | Phase 1 returns empty rendered text; “as checked” / “'s value” wording is refused naming phase 2 rather than storing `""`. |
| Cell contains nested link/span | Return rendered text. |
| Cell text contains commas/newlines | Preserve content after whitespace normalization; JSON keeps row boundaries. |
| Unicode headers/values | Values supported. Explicit aliases required when automatic ASCII aliasing would become empty or collide. |
| Object property typo | Fail before AI action with available properties. |
| Scalar `For each` | Unchanged. |
| Array item is an object from a tool/API | Direct safe properties become dotted bindings using the same rules. |
| Secret-named property | Mask on report/log/UI surfaces, retain raw only in execution scope. The property takes the record-column rule and the root the author-chosen one, either being enough, or the whole name read as one credential key (§7.6): `payment.password`, `token.payee` and `api.key` mask, `payment.sort_key` does not. A dotted name no `For each` registered takes the author rule on the whole key. |
| A record column's value is shorter than four characters | It does not join the free-text mask set (§7.6), which would replace it everywhere. The entry named for it is still masked, at any length — that mask is in place, under its own key. |
| A whole capture under a plain name (`payments`, or one pass's `payment`) | No name rule can catch it. The report redacts by value; the TestBench Variables view and panel mask each secret COLUMN inside the JSON and leave the rest readable. |
| `div[role="grid"]` of `role="row"` / `columnheader` / `gridcell` (MUI DataGrid) | Read as a table by header name (§7.9); `aria-colindex` orders cells; `role="none"` fillers skipped. |
| Pinned columns as row fragments with the same `aria-rowindex` (ag-Grid) | Joined into one record by row index (§7.9). |
| ARIA grid with several header rows | The header grid of §7.3b over `aria-colspan`/`aria-rowspan`. |
| `<table role="grid">` | A table (the tag wins). |
| A `<table>` with data rows and an ARIA grid with data rows under one wrapper | Two things with rows: refused, then the model may be asked (§7.10). |
| Headings as `<td>` in the first body row, no `<th>` | No structural header; the model names the row once (§7.10); cached. |
| Header table after the rows with a paragraph between | Not paired structurally (§7.3a); the model pairs them (§7.10); cached. |
| Repeated cards, no rows or cells | The model answers a collection (§7.10): item selector plus a field selector per column. |
| One key/value table per record | A collection whose item is the table (§7.10). |
| The model answers `none` | The read fails with the original refusal and the model's reason. |
| A cached mapping no longer fits the page (header renamed, cards restyled) | Asked once more, cache rewritten; a second miss fails with both answers logged. |
| `## Config: tableStructure: strict` | No model question: the shape refusal stands. |
| A named header absent from a header that exists | Still the §7.3 refusal listing the available headers; never a model question. |

---

## 11. Implementation map

The implementing agent should inspect and update at least these areas:

### Action vocabulary and planning

- `src/ai/types.ts` — `readTable`, `TableReadColumn`, `columns`.
- `src/ai/action-parser.ts` — whitelist, nested parsing, fail-hard validation.
- `src/ai/prompts.ts` — selection rule and JSON examples.
- `tests/action-parser.test.ts` plus a focused prompt/action test file.

### Browser execution and capture storage

- `src/browser/actions.ts` — shared table extraction and action dispatch.
- `src/runner/step-executor.ts` — `capturedRecords` storage/logging.
- `tests/read-table.test.ts` — real Playwright page tests using the fixtures in
  §5 and every structural error above.
- `tests/read-table-aria.test.ts` — the ARIA table model (§7.9), on inline
  copies of the §5.8 shapes.
- `src/browser/scripts/read-table.js` — the in-page extractor: table or
  wrapper selection (§7.2), the header from another table (§7.3a), the
  header grid (§7.3b), the rendered-cell and detail-row rules (§4.8, §7.4),
  the label from the wrapper, the ARIA table model (§7.9), the sketch and
  the pinned `mapping` path (§7.10).
- `src/runner/step-executor.ts` — the structure question (§7.10): on a
  shape refusal, the sketch → `buildGridStructurePrompt` → one model call →
  validation → the pinned read → `mapping` on the cached action; the
  once-more rule on a cached mapping that no longer fits.
- `src/ai/prompts.ts` — `buildGridStructurePrompt`; `src/ai/action-parser.ts`
  strips `mapping` from model output. The step cache keeps `mapping` with no
  edit of its own: it rides on the recorded action like any other field.
- `src/config/table-structure.ts` — `tableStructureOf`, the one place
  `## Config: tableStructure:` and `aiui.config.json`'s `tables.structure`
  are resolved into one answer.
- `src/runner/structure-memo.ts` — the run's memo (`createStructureMemo`,
  `structureMemoKey`) and the one-per-run lifetime of §7.10, threaded
  through `src/runner/test-runner.ts` (one per data row),
  `src/server/session-manager.ts` (one per batch),
  `src/server/errand-runner.ts` and `src/ui/main/runner-adapter.ts`.
- `tests/read-table-structure.test.ts`, `tests/api-server-table-structure.test.ts`,
  `tests/prompts-grid-structure.test.ts`.

### Object iteration and placeholder paths

- `src/runner/control-flow.ts` — typed object items and pass bindings.
- `src/runner/control-runtime.ts` — list parsing errors/reasoning.
- `src/parser/parameters.ts` — dotted interpolation.
- `src/runner/placeholder-substitution.ts` — dotted reference collection,
  checking, action substitution, and nested action name-field handling.
- `src/skills/expander.ts` — reference discovery/interpolation parity.
- `runner-core/` mirrors where applicable.
- `tests/control-flow-planner.test.ts`, `tests/api-server-control-flow.test.ts`,
  and placeholder parity tests.

### Code-behind

- `src/codebehind/types.ts` and `execute.ts` — shared `tables` context API.
- `src/codebehind/generate.ts`, review/repair prompts and static checks.
- code-behind generation, replay, and stale-healing tests.

### TestBench and reporting

- TestBench runtime-placeholder completion/definition core files.
- Variables view and protocol tests for dotted loop bindings.
- Report/log secret masking tests for record properties.
- The client's two copies of the record-column rule — `runner-core/src/repl.ts`
  for the Variables view, `testbench-native/src/webview/lib/variables-panel.js`
  for the panel — and a parity test reading the server's patterns out of
  `src/utils/secrets.ts`, since `frame:scope` carries raw values and neither
  copy can import the original.
- `frame:scope`'s `bindings` and `unmask` (§7.6): `loopBindingsOf` in
  `src/utils/loop-bindings.ts`, the five emit sites in
  `src/server/session-manager.ts`, the protocol type, the `ScopeMasking`
  argument on `maskIfSecret` / `maskIfSecretInline`, and the thread from the
  event through `RunController` to the Variables view and the webview panel.
- One live TestBench fixture proving extraction -> object loop -> row-scoped
  verification across the real extension/server/browser path.

### Documentation and packaging

- `docs/test-writing-handbook.md` — structured table-read authoring and limits.
- `README.md` — short example near captures/control flow.
- Fixtures and template tests — **built**, on branch
  `claude/loop-table-rows-56d19f` (fixtures in commit 75f0438, baselines in
  a6ce4ce, acceptance tests in a667126). Under `fixtures/test-app/`:
  `tables.html` (the index), `structured-orders.html` (§5.1, with filter,
  sort, expandable rows, tfoot and a "Swap the Order ID and Status columns"
  button),
  `structured-orders-many.html` (14 visible rows + a hidden one for
  `limit`), `scheduled-payments.html` + `payment-details.html` (§5.4),
  `statements.html` (§4.7), `table-edge-cases.html` (eighteen structures —
  the last two are pairs of separate tables that must NOT be read as one
  grid), `split-grids.html` (§5.6: Kendo's split header, grouped, DevExpress
  class names with a hidden column, and frozen columns), `radgrid.html`
  (§5.7: RadGrid static headers with a banded three-row header, filter row,
  spacer, pager and zero-based ids; the non-scrolling form; a plain banded
  table with repeated leaf names), `aria-grid.html` (§5.8: a MUI DataGrid
  measured from the live demo, and an ag-Grid with a pinned-left column —
  neither holding one `<table>`), `odd-tables.html` (§5.9: headings as
  `<td>`, a header table after its rows, a card list with one card hidden,
  and one two-column sheet per record).
  Under `templates/init/tests/`: twelve `table-*.md` acceptance tests tagged
  `table-read` (listed in §12) and four `table-baseline-*.md` tests that
  record what today's runtime does with the same table (§12).
- (Phase 2) A parser for the §7.7 assertion forms beside `set-step.ts` and
  `control-line.ts`, and the shared number/date normaliser it and tools use.
- Because this changes `runner-core` and TestBench-visible behavior, bump the
  patch version in `testbench-native/package.json` as required by `CLAUDE.md`.

### What review found, by round

Every defect below was once narrated inside the rule it produced, which made
the rules read as an argument with an earlier draft rather than as
instructions. The rules stay where they are; the story of how they got there
is here. Each line is the round, what was wrong, and the section that now
states the rule. Two entries predate the review rounds and say so.

- **Building the fixtures** — `scheduled-payments.html` was built with two
  more columns than the draft showed. §5.4 now describes the built page:
  seven columns, the Auto-pay checkbox at 6 and the buttons at 7, with every
  step in this document reading columns 1 to 5.
- **Phase-1 acceptance runs** — a DOM assertion whose right answer was an
  empty cell failed in the assert parser, which read `"expected": ""` as a
  missing field; and a predicate over an empty substituted value was emitted
  with its left operand dropped. §8.3 states both: `expected` must be a
  string rather than a non-empty one, and the prompt keeps the quote marks.
- **Round 1** — "the first row containing `<th>` cells" could not be applied
  literally without taking a `<th scope="row">` row as the header, while an
  implementation requiring *every* cell to be a `<th>` missed the checkbox
  case; with positional columns the header text then became record 1 and
  every `_row` was off by one. §7.3 states the three conditions.
- **Round 1** — an ambiguous header listed the available headers, which the
  author had already typed. §7.3 lists the matching **positions**.
- **Round 1** — a `token` column holding `-` and `7` put every dash and every
  seven in every output, DOM snapshot included, into the free-text mask set.
  §7.6 states the four-character floor and that it governs that set only.
- **Round 1** — a pass whose record lacked a property read the previous
  pass's value (`{{row.note}}` on row 2 said `first`), so the §8.3 refusal
  could never fire; the same leak crossed two loops sharing an item name, and
  the Electron jump-to-step dropped the properties entirely. §8.2 requires a
  fresh rebind through one shared helper, and the cursor to carry the
  properties through every rebuild.
- **Round 1** — an earlier §8.3 said the judge is shown a substituted
  condition. It is not: it receives the authored line and a values block.
- **Round 1** — the first local-decision cut decided a condition with no
  placeholder from its own text, so `Repeat … until "Load more" is empty` ran
  to its cap; and it accepted only the quoted spelling, so the feature's own
  examples still paid a judge call per pass. §8.3a requires an authored
  reference, and quotes the substituted value itself.
- **Round 1** — the same cut covered the `If`/`Else if` chains but not the
  flow-control lines, which are claimed before the chain grammar, so `If
  {{payment.status}} is "Paused", then return` — the line §8.3a opens with —
  still paid a model call per pass. §8.3a covers both paths.
- **Round 2** — the placeholder-row rule read `colspan` against the header's
  column count, which every cell of a one-column table meets, so such a table
  read as `[]` and a loop over it ran zero passes, green. §4.8 states a floor
  of 2.
- **Round 2** — a framework rendering `<thead></thead>` with the headings in
  the first `<tbody>` row was read as headerless, because the element was
  present. §7.3 says absent **or holding no rows**.
- **Round 3** — the prompt's `## Values` block printed a record capture in
  full whenever a step named `{{payments}}` or `{{payment}}`, while the DOM
  beside it was masked. §7.6 states the composition: the name rule, then the
  record's own columns in place, then the free-text set.
- **Round 3** — env and data secrets joined the mask set only in their raw
  spelling, so a value that reached an output JSON- or HTML-escaped was not
  replaced. §7.6 requires the escaped forms too.
- **Round 3** — the client's flat secret rule had been narrowed to whole
  words in round 1, so `mypassword` and `apitoken` rendered raw in the
  Variables view, the panel, the banner and the `[input:]` echo. §7.6 makes
  it the server's regex, read out of the runtime source by a parity test.
- **Round 3** — a dotted reference whose root is an `Object.prototype` name
  (`{{constructor.id}}`) crashed the run at three substitution sites. §8.2
  drops the three prototype names, and every map read on that path is
  own-property.
- **Round 3** — a one-cell `<th>` group row was taken as the header of a
  wider headerless table, so the real heading row became record 1. §7.3's
  step-over is the answer; the round-4 line below records what the first cut
  of it broke.
- **Round 4** — a `<tr><th>Section A</th></tr>` group row was accepted as the
  header of a headerless table, so the real heading row became record 1 and a
  header-named read reported `available headers are Section A`; the first cut
  of the fix then stepped over a one-cell `<th>` row that was genuinely the
  header. §7.3 states the exception and its limit.
- **Round 4** — the client applied the scope rule to an author-chosen map, so
  `user.apikey = uk_live_1234` printed in the Run Rows pick, the gutter hover
  and the Output banner beside a report matrix that said `***`. §7.6 says
  which rule each surface asks.
- **Round 4** — a leading U+FEFF cleared the `/^\s*[[{]/` sniff and then
  threw in `JSON.parse`, and the catch handed the record back unmasked. §7.6
  requires every copy of that scan to strip it first.
- **Round 5** — a row-header row (`<th>` then `<td>`s) counted as the wider
  heading row the step-over looks for, so a genuine one-cell `<th>` header
  above such rows was stepped over and a data row taken as the header. §7.3
  requires a heading row to carry **MORE THAN ONE** `<th>`.
- **Round 5** — the client could not tell a bound `payment.keyword` from an
  author-typed `user.apikey`: the registry that knows is by object identity
  and `frame:scope` sends a copy. §7.6 puts `bindings` on every `frame:scope`
  — `[]` included, since absent has to keep meaning "an older server said
  nothing" — with `unmask` beside it.
- **Round 5** — the report's `For each` band printed a pass's bindings with
  no name rule at all, so a three-character `password` cell showed beside a
  parameter map that said `***`. §7.6 masks the band by name, registry-aware,
  and both marker sites hand their copy its marks.
- **Round 5** — `redactMap` and `redactAuthoredMap` applied the name rule and
  then the free-text set and never the record scan between them, so a
  single-record capture under a plain name printed in full wherever a map is
  rendered. §7.6 states the one composition: name, then the record's columns
  in place, then free text.
- **Round 5** — the Electron runner pushed raw substituted step text into its
  prompt history and its step-start event, and the CLI's `Stored captured
  value as …` log line printed the value raw. §7.6's masking is the run's,
  not one runner's.
- **Round 5** — the client corpora and the control-line parity test imported
  runner-core from its built output, so a source drift passed until someone
  rebuilt. Both import source; §12 item 21d names the mutations that now
  fail.
- **Split grids, review 1 (2026-09-22)** — one round, two reviewers, on the
  §7.3a pairing. Found: both header tables of a frozen grid read `[]` green
  (the pick's beside search saw two candidates and called that "no
  partner"); a walk to `<body>` paired an unnamed empty table with an
  unrelated headerless one two `<div>`s down and refused the empty one;
  candidates were excluded from nesting only relative to the ancestor, so
  two tables in two cells of a layout table paired; a neighbour's refused
  two-row header failed a positional read of the plain table beside it;
  the width and adopted-header refusals named the row table's GUID; a
  dangling `aria-labelledby` and an empty `<caption>` counted as names; the
  suggested `#id` was not CSS-escaped; and the spec said "after it" of rows
  that `aria-owns` may put before. §7.2, §7.3a and §10 now say what the
  code does, in the order it does it, and §12 item 24 names the mutation
  each new test catches.
- **Grid layouts, review 1 (2026-09-23)** — on the header grid (§7.3b), the
  detail row and the stamp. Found in the runtime: a RadGrid box emptied to
  "No records" was refused "found 3 tables with rows", because the header
  table's hidden spacer row and the pager's one row are body rows, so the
  emptied-wrapper fallback now excludes header-only tables and prefers a
  declared header, then `role="grid"` (§7.2); a heading cell holding any
  form control switched to a raw text walk that read `display:none` text,
  naming a column `StatusSORTKEY` and turning a filter cell's hidden span
  into a column name, so the subtraction is now per control and the
  visually-hidden fallback skips those controls too (§7.3b.3); the
  detail-row rule swallowed a merged row at width three, where
  `<td>a</td><td colspan="2">b</td>` covers the width one cell short, so it
  now needs a two-cell margin (§7.4); a refused read still stamped the page,
  and stale stamps survived inside a detail row's nested table (§7.4); a
  BODY row taken as the header whose cells are all blank was treated as no
  header, became record 1 and shifted every `_row`, so §7.3b.5 is a
  `<thead>` rule only; the stamp selector was unscoped, and
  `[data-aiui-row="7"]` alone matches a row in every table read this run
  (§6.3); and the dom-cleaner allowlist was unpinned. Found in the document:
  the width was described as a row's cell count in three places where it is
  the header grid's; the detail-row bullet sat after numbering and `limit`
  although it is applied with the placeholders; the §5.7 skeleton hid rows
  rather than the `<tbody>`/`<thead>` and drew the expand control as an
  `<input>`; and the handbook still refused a merged header and a `<thead>`
  of more than one row.

---

## 12. Verification matrix

### Unit/component tests

1. Valid `readTable` JSON parses with ordered columns — header, positional and
   mixed — and optional `limit` intact.
2. Every malformed action case in §6.2, including invalid `limit`, invalid
   `index`, a column with both or neither of `header`/`index`, and the alias
   `_row`, is rejected without coercion or partial recovery.
3. Checkbox-first HTML produces the exact records in §5.1.
4. Reordered columns produce identical records.
5. Nested markup in cells produces visible text.
6. Hidden rows, nested tables, multiple `<tbody>` elements, and `<tfoot>` obey
   §7.4.
7. Missing/duplicate headers, short selected rows, merged selected cells,
   ambiguous tables, and an unbounded row-cap overflow fail with actionable
   messages.
8. `limit: 10` returns exactly the first ten visible rows in DOM order, skipping
   hidden rows and ignoring malformed rows after the selected prefix.
9. A bounded read returns fewer rows without error when fewer than the requested
   limit are visible, and succeeds on a table containing more than 500 rows.
10. The §5.4 headerless table produces the exact records shown, `_row` first;
    a header-named column against it fails with the §5.4 message; a positional
    column against a table *with* a header reads the cell at that position.
11. `_row` is one-based among data rows: a hidden row and a placeholder row
    between rows 2 and 3 leave row 3 numbered `3`.
12. Empty table produces `[]`, with or without `limit`; the §5.5 placeholder
    body produces `[]` with the skip logged; a placeholder among data rows is
    skipped; a `colspan` narrower than the table still fails.
13. Step executor JSON-encodes records into the named variable.
14. Cached actions preserve `index` and `limit` and reread changed DOM data
    rather than replaying old records. (Phase 3) The same of a *generated*
    action, which does not exist until `tables.read` is emitted.
15. Scalar `For each` regression suite stays green.
16. Object `For each` binds the base JSON and all direct properties in order.
17. A missing object property fails before any model call; a key no
    placeholder can spell is dropped, reported once per loop entry, and named
    in that refusal — never bound, never a guard failure (§8.2).
18. Dotted placeholders substitute in step text and every string leaf of an
    emitted action, but `columns[].key` is not substituted.
19. Loop markers, reports, and TestBench scope carry the current properties.
20. Secret-named record properties are masked on every presentation surface.
21. (Phase 3) Generated code uses the shared table helper, compiles, and
    replays against reordered columns with zero AI calls.
21a. From the first review round, each a mutation the suite did not catch:
    a one-column table (with and without a header) reads all its rows; a
    `<td>`+`<th>` header row is the header and never record 1; a
    `display:contents` grid table and a `display:contents` cell read
    normally; rows appended directly under `<table>` are read; a
    `colspan="99"` message row is a placeholder; a `token` column holding
    `-` and `7` adds nothing to the mask set, and `keyword`/`sort_key`
    columns are not secret while `api_key` is; the step executor stores the
    records under `as` and a mutation stripping `_row` fails; the §7.6
    summary formatter's four shapes; `"0012" is "12"` is decided false and
    `"5" is at least 10` numerically; `If {{x}} is "a"` is decided locally
    and `If "Welcome back" is empty` is judged; a pass lacking a property
    is refused rather than reading the previous pass's, in all three loops,
    and across two loops sharing an item name; a jump-to-step keeps the
    records' properties; the extractor's page callback runs under `tsx`
    (esbuild `keepNames`) as well as `tsc`; the `For each` header warns as
    unresolved in none of the loops; `{{a.b.c}}` warns instead of staying
    silent.
21b. From the second review round, where the rules above were made to say
    what the code does: a one-column table with a lone `colspan="2"` message
    row reads `[]` rather than failing as a merged cell, while its
    `colspan="1"` rows are data; `rowspan="0"` is a merged cell; a headerless
    table whose only rendered row is the full-width message measures its
    width over the hidden rows and reads `[]`; an empty `<thead></thead>`
    with the headings in the first `<tbody>` row finds that header, and a
    `display:none` template row in front of them is skipped. On the client:
    `payments` and `payment` render with their secret columns replaced and
    their other columns readable, a dotted `payment.sort_key` is NOT masked
    while `payment.api_key` is, and `payment._row` leads the properties on a
    record whose other aliases are capitalised.
21c. From the fourth review round, the extractor and the client: a
    `<tr><th>Section A</th></tr>` group row is stepped over and the real
    heading row below it is the header, while a one-cell `<th>` header above
    WIDER data rows is kept — both in `tests/read-table.test.ts`, with
    `a stepped-over group row is a data row — record 1, or a short row (§4.8)`
    pinning that stepping over is not deleting. A leading U+FEFF does not
    smuggle a record past the `/^\s*[[{]/` sniff, in `runner-core/tests/repl.test.js`
    and in `testbench-native/tests/record-secret-parity.test.js` (which also
    compares the two record-masking mirrors body for body, so the strip
    cannot be added to one copy only).
21d. From the fifth and sixth rounds, whose subject was the pins themselves.
    A heading row must carry more than one `<th>`, so a one-cell header above
    row-header data rows survives (`keeps that one-cell header when the DATA
    rows carry row headers (§7.3)` and its `scope="row"` twin,
    `tests/read-table.test.ts`). `frame:scope` carries `bindings` on every
    frame — after a pass, after a TOLERATED failure and after a plain one,
    which are three separate emits in the step loop and were pinned by one
    test until round 6: `says on frame:scope which dotted names the pass
    bound — and unsays them` (`tests/api-server-control-flow.test.ts`) and
    `the scope frame beside a failure says whose the dotted names are`
    (`tests/api-server-failure-outcomes.test.ts`), the second of which fails
    when either of the other two spreads is deleted. The report's loop band
    is masked by the binding rule and not the author's —
    `masks the report band by the binding rule` in the same control-flow
    file, which turns `keyword` into `***` when the marks are dropped. And
    the two client parity corpora import runner-core's SOURCE rather than its
    `dist/`, so a mutation of `parseControlLine` fails
    `tests/placeholder-dotted.test.ts` and one of `extractSections` fails
    `testbench-native/tests/sections-copy-parity.test.js`, neither of which a
    build-free `npm test` could have seen before.
22. (Phase 2) Each §7.7 form passes and fails on a fixed record list, the
    failure names the offending rows, and the number parser accepts `$1,234.56`,
    `+42`, `−$87.40` (U+2212) and `(87.40)` and rejects `n/a` by naming the row.
23. (Phase 2) `mode: 'checked'` reads a ticked and an unticked checkbox as
    `"true"`/`"false"`; `'value'` reads an input and a select's chosen option;
    phase-1 code refuses both modes by name.
24. Split grids (§5.6, §7.2, §7.3a), on inline copies of the shapes on
    `split-grids.html` and of the two negative shapes of
    `table-edge-cases.html` (`tests/read-table.test.ts` is inline HTML in
    real Chromium; the pages themselves are exercised by the acceptance test
    below): the wrapper selector, the row-table selector with `aria-owns`
    and without it, and a header-named read give the same records from the
    Holdings grid; the header-only table is refused naming the wrapper, and
    without a wrapper id or name in the shorter form; a header with no
    partner still reads `[]`, and so does one whose only partner would be
    through `<body>`; the two named tables and the two tables with a
    heading between them are NOT paired (the §5.4 message, and a positional
    read that works), and neither are two tables in two cells of a layout
    table nor a table inside a header-only table's `<th>`; a selected table
    that names itself is never paired; a dangling `aria-labelledby` and an
    empty `<caption>` do not count as names; a width mismatch is refused
    with both counts, naming the grid; a header-only table whose own header
    is refused does not touch the plain table beside it; the frozen grid is
    refused through the wrapper, through its header tables and through its
    locked row table; a wrapper whose header table follows the rows reads
    through `aria-owns` and is otherwise refused (the `precedes` filter);
    the footer table is ignored; a nested table in a data cell does not make
    a second table with rows; the grouped grid's group rows are placeholders
    and the "no records" row reads `[]`; the DevExpress-named grid with its
    hidden column reads `""` for that column with the counts intact. Each
    is a test that fails when its rule is removed.
25. The prompt carries the "SPLIT GRIDS" clause of §6.3, after the
    positional clause it overrides (`tests/prompts-read-table.test.ts`).
26. The header grid (§7.3b), on inline shapes modelled on the RadGrid ones:
    the §5.3
    banded table reads `ID`, `Customer`, `Status` and refuses `Order` naming
    the leaves under it; a blank corner cell with `rowspan="2"` makes the
    grid one wider than the name row; a filter row of inputs is laid out (it
    may widen the grid) and names nothing; `Q1 > Fee` picks the column under
    its band, plain
    `Fee` lists two positions, `Q3 > Fee` fails; a leaf cell with
    `colspan="2"` names two columns and the request is the duplicate
    refusal; `rowspan="0"` in a header runs to the last header row; a
    `<thead>` of blank cells is no header and the `aria-owns` header is used;
    no test expects a HEADER to be refused as merged or as having N rows
    (the merged sentence stays, for body cells); a body cell that spans is
    still refused. Each is a
    test that fails when its rule is removed.
27. RadGrid on an inline shape modelled on `radgrid.html`'s static-headers
    grid: the
    box, the data table and a positional read give the same ten records; the
    header table is refused naming the box; the pager and spacer rows count
    for nothing; the non-scrolling form reads with no pairing; the `<tfoot>`
    pager is excluded; an expanded detail row — an expand cell beside a
    `<td colspan="8">` holding a nested table — is skipped with the
    placeholders and its nested table's rows are not read, while a data row
    with a `rowspan` cell and a full-width row with a `colspan` cell are
    still refused; `aria-owns` with a trailing space resolves; the
    non-scrolling form's self-referential `aria-owns` is ignored; "Applicant"
    matches the leaf under the `APPLICANT` band; the expand column is named
    `ExpandColumn` from its hidden text.
28. The prompt carries the "BANDED HEADERS" (13d) and "ROW IDS" clauses of
    §6.3, and `checkTurnReferences` refuses `${item._row}` in a selector
    when `item._row` is bound and the run has no environment, naming
    `{{item._row}}` (`tests/step-executor-placeholders.test.ts` or the
    placeholder-substitution suite).
28a. The stamp (§7.4): a read leaves `data-aiui-row` 1..N on exactly the data
    rows; a re-read after a filter hides a row renumbers and clears the
    hidden row's stamp; a refused read leaves no stamp at all; a stale stamp
    inside a detail row's nested table is cleared with the rest; an inserted
    detail row does not shift the numbers; RadGrid's `__7` row carries
    `data-aiui-row="8"`; the DOM snapshot keeps the attribute.
29. The ARIA table model (§7.9), on inline copies of the §5.8 shapes: the
    MUI grid reads by header name with `aria-colindex` ordering and the
    `role="none"` filler skipped; `aria-rowindex` is not `_row`; ag-Grid's
    pinned fragments join by `aria-rowindex` (and by `row-index` when
    `aria-rowindex` is absent) into one record; two header rows form a
    header grid over `aria-colspan`; a nested grid's rows are not read; a
    `<table role="grid">` reads as a table; a `<table>` and an ARIA grid
    both with data rows under one wrapper are refused; hidden rows are
    excluded; a row with no cells is skipped and counted.
30. The structure question (§7.10), against a fake model in
    `tests/read-table-structure.test.ts` and through the api-server entry in
    `tests/api-server-table-structure.test.ts` (the FakeApiClient pattern):
    each shape refusal produces a sketch and NO other refusal does; the
    sketch is capped and masks a secret column; a `table` answer naming a
    table not in the sketch, a rows table with no data row, a header row
    naming nothing, or mismatched widths fails naming the fault; a valid
    `table` answer reads the §5.9 `<td>`-headed table and the
    header-after-rows pair; a `collection` answer reads the card list and
    the key/value tables, refuses an item selector matching nothing or
    more than 500, refuses a field matching two elements in an item, reads
    `""` and counts a field missing in some items, fails one missing in all;
    a `none` answer fails with the reason; the validated `mapping` is on the
    cached action and a second run through the api-server makes NO model
    call; a mapping that no longer fits asks once more and rewrites the
    cache, and a second miss fails with both answers; two steps reading the
    same region in one run ask exactly once (the memo), a third with other
    columns asks again, and a memo entry that no longer validates is
    re-asked; `mapping` emitted by
    the model is stripped by the parser; `tableStructure: strict` in
    `## Config` and `tables.structure` in `aiui.config.json` turns the question off.
31. The structure prompt (`tests/prompts-grid-structure.test.ts`) carries the
    three answer kinds, the "answer from the sketch only" rule, the
    collection rules, and `none`; and rule 13d carries the ARIA-grid and
    the "never hand-build a table read" clauses of §6.3.

### End-to-end proof

The fixtures exist (§11) and so do the tests: `aiui run -t table-read` from
`templates/init` runs the twelve acceptance files, and phase 1 is done when
they are green through the CLI and through TestBench. The three proofs below
are `table-orders.md`, `table-orders-limit.md` and
`table-payments-review.md`; the other five are `table-payments-approve.md`
and `table-payments-reference.md` (the "after" of two baselines),
`table-statements.md` (§4.7), `table-documents-empty.md` (§4.8/§5.5) and
`table-structures.md` (grouped `<tbody>`, header-in-tbody, `<tfoot>`, no
header). The ninth, `table-split-grids.md`, is the §5.6 proof: the model is
shown the Holdings grid and must emit a `readTable` against the wrapper or
the row table with the columns named by header; the records are checked
against the page row by row, the swap is run and the read repeated, and the
grouped Dividends grid is read through its group rows. A live run of it is
the measurement of the prompt clause in §6.3 — what the model actually
selected is in the run log, and the runtime's pairing and refusal are what
make either choice come out right. The tenth, `table-radgrid.md`, is the
§5.7 proof on the Loan applications RadGrid: a read by header name of
Applicant, Amount and Status; a loop that clicks Review in row
`{{application._row}}` and checks the banner names that applicant, on a page
where two applicants share a name; an Expand on row 1 and a second read that
still returns ten records past the detail row; the Status filter set to Declined and a
second read that returns only those; the non-scrolling grid read by
header with no pairing; and the plain Quarterly fees table read as
`the "Q1 > Fee" column as q1_fee`, which is the only end-to-end exercise of
§7.3b.4 — the leaf name `Fee` sits under both `Q1` and `Q2`, so the plain
name is the duplicate refusal and the band is what picks the column. The run
log must show no selector built from a row number, and the summary line
`(header from a separate table)` on the static-headers reads. The eleventh, `table-aria-grid.md`, reads the
MUI-shaped and the ag-Grid-shaped grids of §5.8 by header name, joins the
pinned fragments, and loops over the records with a per-row click; the
twelfth, `table-odd-shapes.md`, reads the four §5.9 shapes — each first read
is a model question, and the run log must show the sketch, the answer and
the `(structure from the model: …)` note, then a second read of the same
shape in the same test must show `structure reused from step 2` — the
run-scoped memo, not a question.

**The baseline** (`table-baseline-view/approve/reference/pay-overdue.md`,
run 2026-09-21 with today's runtime, one string per pass) is what phase 1
has to beat, and it is more subtle than "by name fails":

- *view* passed 5/5 and opened the right Origin Energy both times — because
  the step prompt's Prior Steps history let the model reason "already
  reviewed" and the two rows differ in status. Inference that happened to
  have something to work with.
- *approve* came back green with pass 3 having approved nothing: no Approve
  button in "the row for Origin Energy" → the model emitted a `noop`, the
  click step passed, `otherwise continue` never fired, and the verify passed
  on the *other* Origin Energy row. Nothing approved, every step green.
- *reference* failed on pass 1 both times: the judge read "the row for Origin
  Energy" as row 3 (empty), the assertion in the branch it chose read it as
  row 1 (INV-2291). Two model calls in one pass, two rows.
- *pay-overdue* (`Repeat … until`) was clean in one pass.

So the proving runs must show not only green, but that each pass acted on
the row its record came from — which is why the tests below name
`row {{payment._row}}` in both the click and the verify.

Create a real fixture based on §5.1 and a test containing:

```markdown
## Steps
1. Navigate to /structured-orders.html
2. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders]
3. For each {{order}} in {{orders}}, Check the order

### Check the order
1. Verify the Orders table has a row for "{{order.id}}" and customer "{{order.customer}}"
2. Verify the row for "{{order.id}}" shows "{{order.status}}"
```

The proving run must establish all of the following, not merely a green final
status:

- the recorded action is `readTable`, not three independent reads;
- the stored value is an array of three objects in DOM row order, each with
  `_row` first;
- the loop body runs exactly once per object;
- each body instruction contains the correctly substituted property values;
- the checkbox column never appears in any record;
- TestBench displays three iteration bands and current dotted variables;
- the HTML report shows all three passes;
- after compilation, the same run performs no model call for the table-read
  step and returns the same records.

Add a second end-to-end test for the bounded interaction form:

```markdown
## Steps
1. Navigate to /structured-orders-many.html
2. Read the Order ID column as id from the first 10 visible rows in the Orders table [store as: orders]
3. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
```

The fixture must have at least twelve visible rows plus a hidden row before the
tenth visible row. The proving run must show `limit: 10`, exactly ten captured
records and loop passes in visible DOM order, no click for the hidden row or the
eleventh/twelfth visible rows, and fresh row lookup by ID for every click.

Add a third end-to-end test on a headerless fixture with a duplicate payee —
§5.4 grown to five rows, each with a View button that opens a details page:

```markdown
## Steps
1. Navigate to /scheduled-payments.html
2. Read the 1st column as payee, the 3rd column as amount and the 5th column as status from every row in the Scheduled payments table [store as: payments]
3. For each {{payment}} in {{payments}}, Review the payment
4. Verify the Scheduled payments table still shows 5 rows

### Review the payment
1. If {{payment.status}} is "Overdue", then return
2. Click View in row {{payment._row}} of the Scheduled payments table
3. Verify the Payment details page shows "{{payment.payee}}" and {{payment.amount}}
4. Click Back to scheduled payments
```

The proving run must show `index` columns and no `header`, five records with
`_row` 1 to 5, the Overdue pass (row 4) ending at its first step with a
`not-taken` skip on the rest, and — the point of the fixture — both Origin
Energy passes (rows 1 and 3) opening *different* details pages, with the
amount on each matching that pass's `{{payment.amount}}`: $140.00 and
$86.10. A run that opens the first Origin Energy row twice is the failure
this test exists to catch. The `return` is on Overdue and not on Paused for
that reason: the Paused row *is* the second Origin Energy, and a first
draft of this test returned on it, passed, and never opened the page the
fixture was built to distinguish.

---

## 13. Acceptance criteria

The feature is complete only when:

1. (Phase 1) The canonical test in §4.1 works through CLI and Sessions API.
2. (Phase 1) The TestBench live path in §12 works and paints/reports loops
   correctly.
3. (Phase 1) Header-based extraction survives column reordering and a checkbox
   first column without changing the test.
4. (Phase 1) No supported structural error can silently misalign fields across
   rows.
5. `{{item.property}}` works consistently in authored step text, cached
   actions and reports (phase 1), and in generated code-behind and editor
   runtime scope (phase 3).
6. (Phase 1) Existing flat plural reads and scalar `For each` tests remain
   unchanged and green.
7. (Phase 3) Code-behind replay uses the same extractor as the AI action.
8. (Phase 1) Limits, unsupported structures, empty tables, placeholder rows,
   pagination, virtualization, and snapshot semantics are documented.
9. (Every phase) Documentation and the TestBench patch version are updated in
   the same change.
10. (Phase 1) An authored first-N read produces a validated `limit`, selects
    visible data rows in DOM order, and drives only those object-loop passes
    without positional CSS selectors or retained DOM handles.
11. (Phase 1) A table with no header row is read by position, with the §5.4
    records and the §5.4 error for a header-named column.
12. (Phase 1) Every record carries `_row`, and the §12 duplicate-payee run
    opens two different details pages for the two Origin Energy rows.
13. (Phase 1) The §5.5 placeholder body reads as `[]`, a loading row reads as
    `[]`, and neither is reported as a merged-cell error.
14. (Phase 2) Per-column modes read checkbox state and input/select values
    through the wording §7.4 fixes, and phase-1 builds refuse that wording by
    name.
15. (Phase 2) The four §7.7 assertions run without a model call, and their
    number parsing accepts the currency, sign and Unicode-minus forms listed
    there.
16. (Phase 1) A grid whose header and rows are separate native tables (§5.6)
    reads as one table by header, whether the selector names the wrapper or
    the row table; the header-only table is refused rather than read as
    empty; two separate tables are never paired; a frozen grid is refused
    by name through its wrapper, its header tables and its locked half, and
    never read as the whole grid.
17. (Phase 1) A banded header of any number of rows names each column by the
    lowest heading over it (§7.3b); a band is not a column; `Band > Leaf`
    disambiguates repeated leaves; nothing about a header is refused as
    merged. RadGrid's three-table static-headers grid reads by header name
    through its box and through its data table, and its non-scrolling form
    reads as one table (§5.7).
18. (Phase 1) A `div` grid with ARIA roles reads as a table by header name,
    pinned fragments joined by row index (§7.9); MUI DataGrid and ag-Grid
    shapes are in the fixture app and the acceptance suite.
19. (Phase 1) A read that fails for a shape reason asks the model once for
    the structure, validates the answer against the page, reads
    deterministically, caches the mapping, and never asks on a cached run;
    the four §5.9 shapes read; `tableStructure: strict` turns it off;
    a named-header typo is never a model question (§7.10).
20. (Phase 1) A collection answer reads repeated elements with one field
    selector per column, with the same `_row`, hidden-item and `""` rules
    as a table (§7.10).

---

## 14. Deferred, and open questions

Moved out of v1 after review, each with why and what would bring it back:

- **Rendering an empty binding as `""`.** §8.3 makes authors quote a
  placeholder that can be empty. The runtime could instead substitute `""`
  when the placeholder stands alone between spaces in a *condition*, and
  nothing elsewhere; that needs the judge prompt and the substituter to
  agree on what "stands alone" means, so it waits for a second case.
- **A `noop` that passes a click step.** Seen in the approve baseline (§12):
  asked to click a button that is not there, the model emits a no-op and the
  step passes, so `otherwise continue` never sees a failure. Not a table
  problem — it is the step executor's treatment of an empty plan — but
  tables are where it hides a wrong pass behind a green one. Belongs to the
  step-failure-outcomes story.
- **Inclusive row windows** (`startRow`; “rows 3 through 7”, last N, “row N
  onward”, disjoint ranges). The first draft specified them in full. Nothing
  needs them yet, `_row` covers “one row by position”, and `limit` covers the
  smoke subset. The draft's validation rules are in this file's history if a
  test turns up that needs them.
- **Breaking out of a loop.** `return` ends the pass and `stop` ends the test;
  there is nothing for “stop after the first Overdue”. The handbook lists “no
  Break” as a known hole of the control-flow story, and the honest form today
  is find-then-act with no loop (“Click Pay now in the first row whose Status
  is Overdue”). A `then break` tail is the obvious shape; it belongs to the
  control-flow story, not here.
- **Per-row failure summary.** `otherwise continue` already lets a pass
  survive a failing step, and the pass runs on to its end. What is missing is
  the report line — “3 of 40 rows failed: rows 7, 19, 31” — and a collapsed
  pass in the report and in TestBench when it passed cleanly. Forty passes of
  four steps is 160 rows nobody reads.
- **A `<tbody>` totals row steps over a genuine one-cell header**
  ([issues/058](../../issues/058-tbody-totals-row-steps-over-a-one-cell-header.md)).
  The step-over of §7.3 asks whether a wider heading row — more than one
  `<th>` — follows the candidate, and a totals row written as
  `<tr><th>Total</th><th>12</th></tr>` inside `<tbody>` answers yes from
  BELOW the data. Measured: a table whose header is `<tr><th>Order ID</th></tr>`
  then reads as headerless, and a positional read makes `Order ID` record 1
  and numbers every real row one too high. The same totals row in `<tfoot>`
  reads correctly, because only body rows are scanned. The candidate fix —
  count a wide heading row only before the first body row containing no
  `<th>` — was written during review 6 and measured green there (83 read-table
  tests plus probes), and left out because it moves the line and the next shape past it is not
  known.
- **A headerless table of row-header rows loses its first row**
  ([issues/059](../../issues/059-all-row-header-table-loses-its-first-row.md)).
  `<tr><th>O-1</th><td>Delete</td></tr>` repeated with nothing above it has
  no header, but the first such row contains a `<th>`, carries no
  `scope="row"` and is not a lone spanning cell — §7.3's three conditions —
  so it is taken as the header and spliced out of the body. Measured: three
  such rows read as two records starting at `O-2`. `scope="row"` is the
  escape hatch and is the markup the shape should carry anyway (§10). The
  candidate fix — refuse a multi-cell candidate whose `<th>` positions match
  the next body row's, which makes it a row-header COLUMN rather than a
  header row — was measured green over 98 tests during review 6 and left out for
  the same reason.
- **Repeated elements with no roles** — card lists, responsive tables that
  become card stacks at a phone viewport, key/value tables per record — are
  read through §7.10's collection answer, one model question per structure.
  A structural reader for them (a `readCollection` with an item selector
  and field selectors the AUTHOR writes) would make them free of the
  question; nothing has needed it yet. ARIA grids read structurally (§7.9),
  and a grid whose header and rows are two native tables is read as one
  (§5.6, §7.2, §7.3a).
- **A heading row below the eighth cannot be named.** §7.10's sketch lists at
  most eight rows per candidate — fewer once it is shrunk to fit its byte
  budget — and the model may answer only from what the sketch lists, so a
  region whose headings sit under nine rows of preamble gets `none` or a
  wrong row rather than the right one. Raising the cap costs prompt budget on
  every question for a shape nothing has hit yet; the narrower fix, listing
  the first rows AND any row whose cells read as the requested column names,
  needs a rule for "read as" that the sketch deliberately does not have.
- **Trees.** A `role="treegrid"` reads flat: every rendered row is a data
  row and `aria-level` is not carried. A collapsed subtree's rows are not
  in the DOM, so they are not read, which is the virtualisation rule again.
- **Group footers and in-body totals.** A Kendo group footer, or a "Closing
  balance" row in a statement, is a normal-width row of `td` cells. Nothing
  structural marks it, so it reads as a record with blank fields. The honest
  fix is the author's: a filter such as "rows where Amount is not empty",
  which is phase 2's list-assertion territory, not an extractor rule.
- **Editable rows.** A row whose cells hold inputs with values reads as blank
  text in phase 1; phase 2's `value` mode reads the inputs. No row is skipped
  for holding inputs — only a `<thead>` row is a filter row (§7.3b) — because
  an editable grid's data rows look exactly like one.
- **Cloned floating headers.** DataTables' FixedHeader clones the `<thead>`
  into a header-only table appended to `<body>`. The original keeps its
  header, so it reads; the clone, if a model ever selects it, reads `[]`
  because its partner has a header of its own. A refusal for "a header-only
  table whose partner already has a header" would close it.
- **Frozen (locked) columns.** Kendo, DevExpress and Syncfusion render a
  frozen grid as two header tables and two row tables, the columns split
  between the pairs and every row present in both. §7.2 and §7.3a refuse
  the wrapper, both header tables and the locked row table by name; the
  unlocked row table reads as the headerless table it is, and a row table
  that declares its header through `aria-owns` reads its own half by
  header. Reading the whole grid means joining the two row
  tables by position — the same row index in each — into one record, which
  is another pairing rule and a fixture nobody has needed yet; the Frozen
  holdings grid on `split-grids.html` is there for when one does.
- **Indexing the captured list** (`{{payments[5].status}}`). One index
  segment, one-based to match `_row`, and stale by design. Page reads cover
  the real cases so far (§4.5).
- **Loop bodies are uncompiled and uncached.** Every step in a `For each` body
  goes to the model on every pass, so a 40-row table with three steps per row
  is 120 model calls a run. `readTable` compiles; the body does not. Once
  tables loop properly this is the cost felt first, and it needs its own story
  under the code-behind work rather than a note here.
- **Per-row evidence.** A screenshot per pass, named by a record field, for
  the audit trail a payments table wants. Report/evidence story.
- **TestBench never sends `## Config: unmask:` to the server.**
  `RunController`'s per-session `config` object is built from three keys —
  `baseUrl`, `timeout`, `viewport` — so a test's `unmask` list reaches the
  server only on the CLI and MCP paths, which read it straight off the parsed
  test. The hatch is therefore inert end to end for a TestBench run: the model
  sees `***` in the `## Values` block and the Variables surfaces star the name,
  not because the client cannot read an `unmask` list (it can — `frame:scope`
  carries one and `maskIfSecret` honours it, §7.6) but because the run never
  declared one. The fix is one more key on that object, and it is listed here
  rather than done with the wire because it changes what the MODEL is shown on
  every test that declares `unmask` — a prompt change, not a masking one — and
  because per-session `config` is write-once, so an edited `unmask:` line would
  not take effect until the session recycles, which today only a `viewport`
  edit triggers.
- **The code-behind compile and repair prompts carry no free-text
  mask set** (and no `unmask`). `buildStepCodePrompt` and `buildRepairPrompt`
  both call `formatParameterBlock` with an empty `unmask` and an empty
  `secrets` list, so a value is masked in the `## Parameters` block when its
  own NAME says secret and when the record rule says a column does, but a
  secret appearing in the step's prose, in a recorded action or in a captured
  value under an innocent name is written into the prompt in clear. That is
  today's behaviour and predates this feature; it is listed here because
  `readTable` is what makes a page-derived record ordinary. The fix is the
  run's mask set and its unmasked names reaching the compile path — the same
  shape of plumbing `frame:scope` now does for the client (§7.6), one layer
  in: the compile has the live map already and needs what the run knows about
  it, rather than a wire field.
