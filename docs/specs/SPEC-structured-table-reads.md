# Structured table reads and object-aware `For each`

**Status:** Proposed  
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

1. A deterministic `readTable` AI action that reads named columns from every
   visible data row, the first N visible rows, or an explicitly bounded
   contiguous window of visible rows, and stores one object per row.
2. Object-aware `For each`, so a row bound as `{{order}}` exposes direct
   properties such as `{{order.id}}` and `{{order.status}}`.

There is deliberately no new “table loop” syntax. `For each` remains the one
list loop, and structured records can later come from APIs or tools as well as
HTML tables.

The intended flow is:

```text
native HTML table
  -> readTable action
  -> JSON array of row records in the string-valued variable map
  -> existing For each planner
  -> base binding {{order}} plus property bindings {{order.id}}, etc.
  -> ordinary steps which re-find an interactive row by a stable value
```

The runtime must never keep a DOM element handle between steps or iterations.
Modern applications rerender rows, which makes such handles stale. Extraction
is a snapshot; later page actions locate the row again using a value such as an
order ID.

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

---

## 2. Goals

- Read two or more explicitly named columns from a native HTML `<table>` in one
  action while preserving row alignment.
- Ignore unrelated columns, including checkbox/select columns, when the author
  did not request them.
- Resolve columns by header text rather than by an AI-chosen `nth-child()`.
- Return a JSON array of flat row objects whose values are strings.
- Allow an author to intentionally restrict extraction to the first N visible
  data rows or an inclusive visible-row range without encoding row positions in
  a CSS selector.
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
- Array indexing or arbitrary expression evaluation in placeholders. V1 adds
  one direct property segment (`{{row.property}}`), not
  `{{rows[0].property}}`, functions, or arithmetic.
- Recursively flattening nested objects. `readTable` emits flat objects.
- Last-N selection, open-ended “row N onward,” disjoint ranges, sorting, or
  random row sampling. V1 supports only all visible rows, the first N visible
  rows, or one bounded contiguous window in visible DOM order.

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
`__proto__`, `prototype`, or `constructor`.

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

### 4.4 Bounded visible-row windows

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
re-finds its row from a stable captured column. If clicking the whole row is not
the application behavior, the author should name the control instead, for
example `Click Review in the ... row`.

An inclusive range uses the same capture-and-loop form:

```markdown
## Steps
1. Read the Order ID column as id from visible rows 3 through 7 in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
```

The read emits `startRow: 3` and `limit: 5`. Author-facing row numbers are
one-based and both endpoints are inclusive. Hidden and non-data rows do not
count, so “rows 3 through 7” means the third through seventh rows remaining
after the exclusions in §7.4. If only five visible rows exist, the read captures
rows 3 through 5. If fewer than three exist, it captures `[]`. An exact five-row
requirement needs a separate assertion that at least seven visible data rows
exist.

The exact prose `Loop through row 3 to row 7 and click on each row` is not a new
control line: the framework cannot safely retain five DOM row handles through a
loop. Authors express it as the bounded read followed by the existing
`For each`, naming at least one stable column that later actions can use to
re-find each row.

### 4.5 Pagination

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

### 4.6 Empty tables

An empty `<tbody>` produces `[]`, and `For each` runs zero passes. If emptiness
is a test failure, say so separately:

```markdown
1. Verify the Orders table contains at least one data row
2. Read the Order ID column as id and Status column as status from every row in the Orders table [store as: orders]
```

This matches the existing empty-list behavior of plural reads and `For each`.

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
  { "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" },
  { "id": "ORD-1002", "customer": "Bob Jones", "status": "Pending" }
]
```

The checkbox, Total, and Actions columns are not present because the author did
not request them.

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
[{ "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" }]
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

---

## 6. AI action contract

### 6.1 Action shape

Add `readTable` to `ActionType` and add a table-column type:

```ts
export interface TableReadColumn {
  /** Visible header text, matched after whitespace/case normalization. */
  header: string;
  /** Property written on every output row. */
  key: string;
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
/**
 * readTable only: one-based position of the first visible data row to capture.
 * May appear only with limit; omission means 1.
 */
startRow?: number;
```

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

Valid response for the bounded example in §4.4:

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

Valid response for visible rows 3 through 7:

```json
{
  "actions": [
    {
      "action": "readTable",
      "selector": "table[aria-label=\"Orders\"]",
      "columns": [
        { "header": "Order ID", "key": "id" }
      ],
      "startRow": 3,
      "limit": 5,
      "as": "orders",
      "description": "Read IDs from visible Orders table rows 3 through 7"
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
- `header` is absent/blank;
- `key` is invalid, dangerous, or duplicated;
- a `(header, key)` pair is duplicated;
- more than 20 columns are requested;
- `limit`, when present, is not a finite integer from 1 through 500 inclusive;
- `startRow`, when present, is not a positive JavaScript safe integer;
- `startRow` is present without `limit`;
- `startRow + limit - 1`, when both are present, is not a JavaScript safe
  integer.

Do not silently drop malformed columns and run a partial read. Partial
structured data is more dangerous than a failed step.

The parser must copy `columns`, a validated `limit`, and a validated `startRow`
into the canonical action; today it only copies known scalar fields and would
discard them. `limit` and `startRow` are `readTable` fields, not configurable
replacements for the existing
`READ_MULTIPLE_MAX` behavior of `read` with `multiple: true`.

### 6.3 Prompt rule

Teach the step-planning prompt:

- Use `readTable` when one step asks for two or more named columns from every
  row of a native HTML table, or explicitly asks for row records/objects.
- Also use `readTable` when the author asks for the first/up to/at most N rows,
  even if only one named column is needed; emit that positive integer as
  `limit`.
- For an inclusive range A through/to B, require positive integers with B >= A,
  emit `startRow: A`, and emit `limit: B - A + 1`. For example, rows 3 through
  7 become `startRow: 3, limit: 5`, not `limit: 7`.
- Use existing `read` with `multiple: true` for one flat column unless the
  author explicitly requests records or a bounded table window.
- Copy header names exactly as observed in the DOM snapshot.
- Copy explicit author aliases exactly; otherwise apply the normalization rule
  in §4.2.
- Request only author-named columns. Never add checkbox, action, or hidden
  columns “for context.”
- Do not calculate `nth-child()` selectors for columns. The runtime maps headers.
- Do not calculate `:nth-child(-n+N)` or similar selectors for a row bound. Use
  `limit`/`startRow`, and emit them only when the author explicitly requested a
  bound.
- Omit `startRow` for first-N wording; its runtime default is 1. Never emit
  `startRow` without `limit`.
- The two fields address only a bounded contiguous window of visible rows on the
  current rendered page. Do not use them to imply pagination, scrolling, last N,
  an open-ended start row, disjoint ranges, sorting, or an exact-row-count
  assertion. For unsupported row-selection semantics or a reversed range,
  return a `prompt` explaining the v1 restriction rather than silently changing
  the meaning.
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

V1 accepts exactly one direct header row belonging to the selected table:

- normally one `<thead><tr>…</tr></thead>`;
- if there is no `<thead>`, the first direct table row containing `<th>` cells
  may be used;
- nested-table rows/cells are excluded by requiring `closest('table')` to be
  the selected table.

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

### 7.4 Row mapping

- Read direct rows from all direct `<tbody>` elements belonging to the table.
- Exclude `<thead>` and `<tfoot>` rows.
- Exclude rows which are not visible at capture time (`display:none`,
  `visibility:hidden`, hidden/collapsed ancestors, or no rendered client rect).
- Exclude nested-table rows.
- Preserve DOM order.
- After all visibility/data-row exclusions, let `start = (startRow ?? 1) - 1`.
  With `limit`, select the zero-based slice `[start, start + limit)` before cell
  extraction. Without `limit`, `startRow` is forbidden and all visible rows are
  selected.
- Reject body cells with `rowspan` or `colspan` greater than 1.
- A row missing any requested logical cell fails the whole action and names the
  one-based visible row number and header. Never drop the row or shift values.
  Cell-shape validation applies to selected rows; an unselected row after the
  explicit limit cannot fail the bounded read.
- A `rowspan` originating before `startRow` can affect logical positions inside
  the selected window. Detect and reject any earlier body-cell `rowspan` whose
  span intersects a selected row. A merge wholly outside the selected window
  cannot fail the read.
- Extra cells are harmless.

Cell value v1 is rendered cell text: trimmed and with runs of whitespace
collapsed to one space. Nested links/spans therefore read normally. An empty
cell is stored as `""` and is not dropped.

A requested cell containing only a form control or icon may therefore produce
`""`. Reading control state (`checked`, selected option, input value) is a
future extension with an explicit extraction mode; v1 must not guess that
`<input value="on">` means checked.

### 7.5 Limits and atomicity

- Maximum requested columns: 20.
- Maximum output rows: 500. Consequently, `limit` must be between 1 and 500.
- `startRow` is one-based, defaults to 1, and is legal only with `limit`. It has
  no arbitrary 500-row ceiling; the safety cap applies to captured output size,
  not to the requested starting position.
- With no `limit`, if the table has more than 500 visible rows, fail. Unlike the
  existing flat plural read, do not silently truncate structured records: a
  partial business table can produce a convincingly wrong result.
- With an explicit `limit`, a table may contain more than 500 visible rows. Read
  only the requested window beginning at `startRow ?? 1`. This is intentional
  author-requested selection, not a safety-cap truncation.
- If fewer than `limit` visible rows remain at or after `startRow`, return that
  existing suffix without error.
- If `startRow` is beyond the last visible row, return `[]`. If the requested
  window extends past the end, return only its existing suffix. Neither case is
  an implicit cardinality assertion.
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

For a non-default start, log both fields:

```text
readTable captured 5 rows × 1 column as "{{orders}}" (start row 3, limit 5)
```

Do not write every captured cell to the normal console/run log. Existing
variable/report surfaces may show captured variables, but their secret masking
must recursively inspect record keys: values under keys matching the existing
password/secret/token/key rule must be masked even though the root variable is
named `orders`.

The action is observational and must not trigger post-action page settling.

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
{ "id": "ORD-1001", "customer": "Alice Smith", "status": "Completed" }
```

the pass binds:

```text
order          = {"id":"ORD-1001","customer":"Alice Smith","status":"Completed"}
order.id       = ORD-1001
order.customer = Alice Smith
order.status   = Completed
```

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

with no whitespace. Both segments use `[A-Za-z_][A-Za-z0-9_]*`.

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
{{order.statuz}} has no value in For each item 2; available properties are id, customer, status
```

Do not pass the literal braces to the model. Existing unresolved flat-name
compatibility is outside this feature and remains unchanged.

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
  must derive only explicit `as <key>` aliases and must not guess from prose.
- Go-to-definition for `{{order.id}}`, if offered, should target the `For each`
  line; field-level definition navigation is not required.

---

## 9. Code-behind and cache behavior

### 9.1 Cached AI actions

A cached `readTable` plan must execute against the current DOM and capture fresh
records, exactly as a cached `read multiple` action does. Cache only the action
shape (`selector`, headers, keys, optional `startRow`, and optional `limit`),
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
      { header: 'Status', key: 'status' },
    ],
    startRow: 3,
    limit: 5,
  });
  step.setVar('orders', JSON.stringify(rows));
}
```

`tables.read` and the AI action must call the same underlying extraction helper.
There must not be one header algorithm in generated code and another in
`actions.ts`. The optional `startRow`/`limit` window must have identical
validation and visible-row semantics in both paths.

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
| Row has too few cells | Fail the whole read with row/header detail. |
| Hidden filtered row | Excluded before applying `limit`; it does not consume one of the N slots. |
| Hidden requested column | Cells remain structurally aligned; rendered text is empty, so store `""` for that field. |
| Nested table inside a cell | Nested rows/cells are excluded from both header and body scans. |
| Multiple `<tbody>` elements | Include their visible direct rows in DOM order. |
| `<tfoot>` totals row | Excluded. |
| Row-header `<th scope="row">` in body | Counts as that row's cell at its logical position. |
| `rowspan`/`colspan` > 1 in a selected row | Fail as unsupported in v1; also fail for an earlier `rowspan` that intersects the window. |
| More than 500 visible rows, no `limit` | Fail; never truncate implicitly. |
| More than 500 visible rows, valid window | Capture at most `limit` rows beginning at `startRow ?? 1` and succeed. |
| Fewer remaining visible rows than `limit` | Capture the existing suffix and succeed; exact cardinality requires a separate assertion. |
| `limit` is zero, negative, fractional, a string, or greater than 500 | Parser rejection; never coerce or clamp. |
| `startRow` is zero, negative, fractional, a string, or exceeds JavaScript's safe-integer range | Parser rejection; never coerce or clamp. |
| `startRow` without `limit` | Parser rejection; open-ended windows are unsupported in v1. |
| `startRow + limit - 1` exceeds JavaScript's safe-integer range | Parser rejection; range arithmetic must remain exact. |
| Rows 3 through 7 | Emit `startRow: 3, limit: 5`; capture visible rows 3, 4, 5, 6, and 7. |
| Range begins past the last visible row | Store `[]`; `For each` runs zero passes. |
| Range ends past the last visible row | Capture the existing suffix without error; exact cardinality requires a separate assertion. |
| Reversed range such as rows 7 through 3 | Prompt as unsupported/invalid; do not swap endpoints. |
| Hidden rows before/inside the requested positions | Ignore hidden rows, then apply the one-based window to visible data rows. |
| Malformed row outside the selected window | Ignore it unless an earlier `rowspan` intersects the selected window. |
| Author asks for last N, row N onward, or disjoint ranges | Unsupported in v1; do not reinterpret as a supported window. |
| Pagination plus a bounded window | Apply `startRow`/`limit` independently to the currently rendered page on each invocation; never navigate automatically. |
| More than 20 requested columns | Parser rejection. |
| Empty table | Store `[]`; `For each` runs zero passes. |
| Virtualized table | Capture only currently rendered visible rows. No auto-scroll. |
| Table rerenders after capture | Loop uses the captured snapshot; later actions re-find rows and may fail honestly if a row vanished. |
| Duplicate row identifiers | Extraction succeeds; a later action using that identifier may fail as ambiguous. `readTable` does not assume which field is a key. |
| Icon/control-only requested cell | V1 returns empty rendered text; explicit control-state extraction is future work. |
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
- A template fixture/test under `templates/init/tests/` and HTML under
  `fixtures/test-app/`.
- Because this changes `runner-core` and TestBench-visible behavior, bump the
  patch version in `testbench-native/package.json` as required by `CLAUDE.md`.

---

## 12. Verification matrix

### Unit/component tests

1. Valid `readTable` JSON parses with ordered columns and optional
   `startRow`/`limit` intact.
2. Every malformed action case in §6.2, including invalid `limit`, invalid
   `startRow`, `startRow` without `limit`, and unsafe range arithmetic, is
   rejected without coercion or partial recovery.
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
10. `startRow: 3, limit: 5` returns visible rows 3 through 7; hidden rows do not
    count, a partial suffix is allowed, and a start beyond the end returns `[]`.
11. A prior `rowspan` intersecting the selected window fails rather than
    misaligning fields; malformed structure wholly outside the window is ignored.
12. Empty table produces `[]`, with or without a bounded window.
13. Step executor JSON-encodes records into the named variable.
14. Cached and generated actions preserve `startRow`/`limit` and reread changed
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

### End-to-end proof

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
- the stored value is an array of three objects in DOM row order;
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

Add a range variant against the same fixture:

```markdown
1. Read the Order ID column as id from visible rows 3 through 7 in the Orders table [store as: orders]
2. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
```

It must record `startRow: 3, limit: 5`, capture exactly the third through seventh
visible IDs, and perform five row re-lookups/clicks in that order.

---

## 13. Acceptance criteria

The feature is complete only when:

1. The canonical test in §4.1 works through CLI and Sessions API.
2. The TestBench live path in §12 works and paints/reports loops correctly.
3. Header-based extraction survives column reordering and a checkbox first
   column without changing the test.
4. No supported structural error can silently misalign fields across rows.
5. `{{item.property}}` works consistently in authored step text, cached actions,
   generated code-behind, reports, and editor runtime scope.
6. Existing flat plural reads and scalar `For each` tests remain unchanged and
   green.
7. Code-behind replay uses the same extractor as the AI action.
8. Limits, unsupported structures, empty tables, pagination, virtualization,
   and snapshot semantics are documented.
9. Documentation and the TestBench patch version are updated in the same
   change.
10. An authored first-N read produces a validated `limit`; an authored inclusive
    range produces validated `startRow` and `limit` values with correct inclusive
    arithmetic. Both select visible data rows in DOM order and drive only those
    object-loop passes without positional CSS selectors or retained DOM handles.
