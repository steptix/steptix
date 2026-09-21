---
tags: [table-read]
timeout: 600s
---

# Table read — the Orders table, by header

The canonical structured-table read of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
§4.1 and its first end-to-end proof in §12, against
`fixtures/test-app/structured-orders.html`: a `<thead>` table whose first
column is a select-all checkbox with a blank header, Order ID as a link,
Status as a badge, a Review button, and a `<tfoot>` total.

**Requires phase 1 of the spec** (`readTable`, records in the variable map,
`{{item.property}}` bindings). Until it lands, step 2 is a plural read of one
column and step 3's `{{order.id}}` is literal text.

What the proving run must show (§12): the recorded action is one `readTable`,
not three reads; `{{orders}}` holds three objects in DOM order, each with
`_row` first; the checkbox, Total and Actions columns appear in no record;
the loop runs once per object with the properties substituted; and after
the "Swap the Order ID and Status columns" button swaps them, the same read
returns the same records (§5.2) — proved here by running the same per-record
checks over the second read, so a read that came back different or short
after the swap fails a pass. The exact records, and the absence of the
checkbox, Total and Actions columns from them, are pinned in
`tests/read-table.test.ts`; this file checks each record against the page
rather than asserting over the JSON, because `Assert that {{orders}} equals …` or `contains "…"` is
model-evaluated and phase 2's list assertions (§7.7) are the deterministic
form.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to structured-orders.html
2. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders]
3. For each {{order}} in {{orders}}, Check the order
4. Click the "Swap the Order ID and Status columns" button
5. Read the Order ID column as id, Customer column as customer, and Status column as status from every row in the Orders table [store as: orders_after]
6. For each {{order}} in {{orders_after}}, Check the order

### Check the order
1. Verify the Orders table has a row for "{{order.id}}" and customer "{{order.customer}}"
2. Verify the row for "{{order.id}}" shows "{{order.status}}"
3. Verify row {{order._row}} of the Orders table is the order "{{order.id}}"
