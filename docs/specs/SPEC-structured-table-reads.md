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

- Read two or more explicitly named columns from a native HTML `<table>` in one
  action while preserving row alignment.
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

- ARIA grids or `<div role="table">` implementations. V1 supports native
  `<table>` elements only.
- Automatically paging, scrolling a virtual grid, or clicking “Load more.” An
  author composes the existing `While`/`Repeat` forms explicitly.
- Persisting Playwright `Locator` or DOM element handles in variables.
- Editing table cells or selecting rows as part of `readTable`. Those remain
  ordinary later steps.
- Implicitly reading every column when the author names none.
- Merged header/data grids using `rowspan` or `colspan` greater than 1. V1
  rejects them with a diagnostic; silently guessing a logical grid is unsafe.
  The one exception is the placeholder row of §4.8: a single cell spanning
  the whole width is a message, not a grid.
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

- A body row whose only cell spans the whole width of the table (its
  `colspan` equals the header's column count, or the table has no header and
  the row has exactly one cell) is a **placeholder row**, not data.
- If every body row is a placeholder, the table is empty: store `[]`.
- If placeholders sit among data rows, skip them. They do not get a `_row`
  number; `_row` counts data rows only.
- Any other merged cell is still an error.

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
meantime. It reads as deterministic and is not: the substituted step is a
long JSON literal, the model must classify it as a self-contained predicate,
and in the phase-1 acceptance runs gpt-5.6-luna did so about half the time
and otherwise emitted a DOM assertion with no expectation, which fails. The
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

### 5.3 Unsupported merged header

V1 must reject this table rather than pretending `Order` is a single column:

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

Required error shape:

```text
readTable cannot map table "Orders": merged headers or cells (rowspan/colspan > 1) are not supported
```

### 5.4 No header row, and a duplicate payee

The second fixture, built as `fixtures/test-app/scheduled-payments.html`
(five rows there; the first three shown here). No `<thead>`, no `<th>`, two
rows for the same payee, cells that are empty on some rows and not others,
and — as built — seven columns: an Auto-pay checkbox is column 6 (for the
phase-2 `checked` mode) and the buttons are column 7. Every step in this
document reads columns 1 to 5, so the layout change touches none of them.

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
`colspan="3"` cell in a five-column table is still the §5.3 error.

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

- `selector`: CSS selector for one native `<table>`;
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
  row of a native HTML table, or explicitly asks for row records/objects.
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
2. Resolve `selector` and require exactly one matching visible element.
3. Require that element to be a native `HTMLTableElement`.
4. Zero matches fail as not found; more than one fails as ambiguous. Do not call
   `.first()` for `readTable`.

### 7.3 Header mapping

A header row is required only when some requested column names a header. V1
accepts exactly one direct header row belonging to the selected table:

- normally one `<thead><tr>…</tr></thead>`;
- if there is no `<thead>`, the first direct table row containing `<th>` cells
  may be used;
- nested-table rows/cells are excluded by requiring `closest('table')` to be
  the selected table.

If no header row exists and a column names one, fail with the §5.4 message,
which tells the author to name columns by position. If every requested column
is positional, the header row (if any) is still identified so that it is
excluded from the body and so the placeholder-row rule (§7.4) knows the
table's width, but nothing is matched against it.

A positional column (`index`) maps to the cell at that one-based position in
each body row. It ignores the header entirely, so a reordered table changes
what it reads; that is the documented trade-off of §4.4, not a bug.

For each direct header cell:

1. reject `rowspan` or `colspan` greater than 1;
2. derive header text from rendered text (`innerText`), falling back to trimmed
   `textContent` for visually-hidden accessible headings;
3. normalize by trimming, collapsing whitespace, and case-folding;
4. match each requested header by normalized exact equality, never substring.

Every requested header must match exactly one column. A missing header or a
duplicate matching header fails the action and lists the available non-empty
headers.

Blank selection-column headers are valid and ignored unless somehow requested.

Case-folding is load-bearing, not tidiness: the app's table style sets
`text-transform: uppercase` on `<th>`, so `innerText` of the Orders header
is `ORDER ID` while the author wrote `Order ID` and `textContent` says so
too. Step 3's fold makes all three the same key. `tests/read-table.test.ts`
must include a header styled that way.

### 7.4 Row mapping

- Read direct rows from all direct `<tbody>` elements belonging to the table.
- Exclude `<thead>` and `<tfoot>` rows.
- Exclude rows which are not visible at capture time (`display:none`,
  `visibility:hidden`, hidden/collapsed ancestors, or no rendered client rect).
- Exclude nested-table rows.
- Preserve DOM order.
- Drop placeholder rows (§4.8): a row whose only cell spans the table's full
  width (`colspan` equal to the header's column count, or exactly one cell in
  a headerless table). If every body row was a placeholder, the result is
  `[]`.
- Number what is left: `_row` is the one-based position among the remaining
  data rows, hidden rows and placeholders excluded. Write it on every record
  before the requested columns, so the report and the Variables panel show it
  first.
- With `limit`, select the first `limit` of those rows before cell extraction.
  Without `limit`, all of them.
- Reject any other body cell with `rowspan` or `colspan` greater than 1.
- A row missing any requested logical cell fails the whole action and names the
  row's `_row` and the header or position. Never drop the row or shift values.
  Cell-shape validation applies to selected rows; an unselected row after the
  explicit limit cannot fail the bounded read.
- Extra cells are harmless.

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

- Maximum requested columns: 20.
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

Do not write every captured cell to the normal console/run log. Existing
variable/report surfaces may show captured variables, but their secret masking
must recursively inspect record keys: values under keys matching the existing
password/secret/token/key rule must be masked even though the root variable is
named `orders`.

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

Reject object keys which do not satisfy the safe identifier rule or are one of
the three dangerous prototype names. A malformed item fails the `For each`
guard and names its one-based item index; it must not partially bind fields.

As with the current scalar item binding, values from the last completed pass
remain in the one live variable map after the loop. This includes dotted
bindings. Do not introduce snapshot/restore semantics only for objects.

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

with no whitespace. The property segment is `[A-Za-z_][A-Za-z0-9_]*`. The
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
send the author hunting for a typo in a working name.

Do not pass the literal braces to the model. Existing unresolved flat-name
compatibility is outside this feature and remains unchanged.

**Empty values.** An empty cell is stored as `""` (§7.4), and a binding of
`""` substitutes to nothing. In a condition that is invisible: `If
{{payment.reference}} is empty, then …` reaches the judge as `If  is empty,
then …`. Authors quote a placeholder that can be empty — `If
"{{payment.reference}}" is empty` reads as `If "" is empty` — and the
handbook says so beside the first dotted example. Whether the runtime should
instead render an empty binding as `""` when the placeholder stands alone
between spaces is an open question (§14); v1 does not, because a `Type
{{payment.reference}} into the field` that typed two quote marks would be
worse than a condition that reads oddly.

Two things the acceptance runs found on the same theme, both fixed in
phase 1. The assert parser rejected `"expected": ""` as a *missing* field,
so a DOM assertion whose right answer is an empty cell — `Verify the
Reference cell in row 2 … is empty` — failed in the parser exactly when the
model answered correctly; it now requires the field to be a string, not a
non-empty one. And a predicate over an empty substituted value reads
literally `"" is empty`; the model once emitted the condition with the
operand dropped, and the prompt now tells it to keep the two quote marks as
the left operand.

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

So the runtime decides such conditions itself. After placeholder
substitution, a condition whose whole text matches the literal grammar
below is decided locally, with no model call, and its guard row carries the
reasoning `decided from the values: "" is empty → true` in place of the
judge's sentence; anything else goes to the judge exactly as before. A value
is a double-quoted string or a bare number; comparisons are exact after
trimming, and numeric when both sides are plain numbers.

```text
<v> is empty | is blank | is not empty | is not blank
<v> is <v> | equals <v> | is not <v> | does not equal <v> | is different from <v>
<v> contains <v> | does not contain <v> | starts with <v> | ends with <v>
<v> is at least <n> | is at most <n> | is more than <n> | is greater than <n> | is less than <n>
```

A chain (`If` / `Else if` / `Otherwise`) is decided locally only when every
member's condition is literal; if any member needs the page, the whole chain
goes to the judge, so one evaluation never mixes the two sources. `While`
and `Repeat … until` conditions get the same treatment on every evaluation.
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
what a control line writes).

### 8.4 Loop reporting and TestBench

- Loop markers and `frame:scope` must include the dotted property bindings so
  the TestBench Variables panel can show the current row fields.
- Secret masking applies using the property segment as well as the complete
  dotted name.
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
| Placeholder row: one cell spanning the full width | Not data. Alone in the body: store `[]`. Among data rows: skipped, no `_row` consumed. Logged as “N placeholder row(s) skipped”. |
| “Loading…” row | A placeholder; the read stores `[]` truthfully. Waiting is the author's step, before the read. |
| A `colspan` narrower than the table | Still the §5.3 error. |
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
| Secret-named property | Mask on report/log/UI surfaces, retain raw only in execution scope. |

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
- One live TestBench fixture proving extraction -> object loop -> row-scoped
  verification across the real extension/server/browser path.

### Documentation and packaging

- `docs/test-writing-handbook.md` — structured table-read authoring and limits.
- `README.md` — short example near captures/control flow.
- Fixtures and template tests — **built**, on branch
  `claude/loop-table-rows-56d19f` (fixtures in commit 75f0438, baselines in
  a6ce4ce, acceptance tests in a667126). Under `fixtures/test-app/`:
  `tables.html` (the index), `structured-orders.html` (§5.1, with filter,
  sort, expandable rows, tfoot and a "Reorder columns" button),
  `structured-orders-many.html` (14 visible rows + a hidden one for
  `limit`), `scheduled-payments.html` + `payment-details.html` (§5.4),
  `statements.html` (§4.7), `table-edge-cases.html` (sixteen structures).
  Under `templates/init/tests/`: eight `table-*.md` acceptance tests tagged
  `table-read` (listed in §12) and four `table-baseline-*.md` tests that
  record what today's runtime does with the same table (§12).
- (Phase 2) A parser for the §7.7 assertion forms beside `set-step.ts` and
  `control-line.ts`, and the shared number/date normaliser it and tools use.
- Because this changes `runner-core` and TestBench-visible behavior, bump the
  patch version in `testbench-native/package.json` as required by `CLAUDE.md`.

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
14. Cached and generated actions preserve `index` and `limit` and reread changed
    DOM data rather than replaying old records.
15. Scalar `For each` regression suite stays green.
16. Object `For each` binds the base JSON and all direct properties in order.
17. Missing/unsafe object properties fail before any model call.
18. Dotted placeholders substitute in step text and every string leaf of an
    emitted action, but `columns[].key` is not substituted.
19. Loop markers, reports, and TestBench scope carry the current properties.
20. Secret-named record properties are masked on every presentation surface.
21. Generated code uses the shared table helper, compiles, and replays against
    reordered columns with zero AI calls.
22. (Phase 2) Each §7.7 form passes and fails on a fixed record list, the
    failure names the offending rows, and the number parser accepts `$1,234.56`,
    `+42`, `−$87.40` (U+2212) and `(87.40)` and rejects `n/a` by naming the row.
23. (Phase 2) `mode: 'checked'` reads a ticked and an unticked checkbox as
    `"true"`/`"false"`; `'value'` reads an input and a select's chosen option;
    phase-1 code refuses both modes by name.

### End-to-end proof

The fixtures exist (§11) and so do the tests: `aiui run -t table-read` from
`templates/init` runs the eight acceptance files, and phase 1 is done when
they are green through the CLI and through TestBench. The three proofs below
are `table-orders.md`, `table-orders-limit.md` and
`table-payments-review.md`; the other five are `table-payments-approve.md`
and `table-payments-reference.md` (the "after" of two baselines),
`table-statements.md` (§4.7), `table-documents-empty.md` (§4.8/§5.5) and
`table-structures.md` (grouped `<tbody>`, header-in-tbody, `<tfoot>`, no
header).

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
- **Grids that are not `<table>`.** `<div role="grid">` (ag-grid, MUI
  DataGrid), card lists, and responsive tables that become card stacks at a
  phone viewport (which the per-test `viewport:` config can now select). §1.2
  says why v1 stops at native tables; a `readCollection` with an item selector
  and per-field selectors is the follow-on, and the positional form of §4.4
  is the same idea for a row whose cells are its direct children.
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
