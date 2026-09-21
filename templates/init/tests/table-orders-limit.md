---
tags: [table-read]
timeout: 600s
---

# Table read — the first ten rows only

The bounded read of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
§4.6 and its second end-to-end proof in §12, against
`fixtures/test-app/structured-orders-many.html`: fourteen visible rows
ORD-2001 to ORD-2014, plus one hidden row (ORD-2099) planted as the eighth
`<tr>`, ahead of the tenth visible row. Clicking a row records its id in the
page's Clicked panel, in order.

**Requires phase 1 of the spec.** Step 2 must emit `readTable` with
`limit: 10` even though only one column is named, because "the first 10
visible rows" asks for a bounded window. "First" is counted after hidden
rows are excluded, so the ten records are ORD-2001 to ORD-2010 and the loop
never clicks the hidden row or the eleventh and twelfth visible ones.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to structured-orders-many.html
2. Read the Order ID column as id from the first 10 visible rows in the Orders table [store as: orders]
3. For each {{order}} in {{orders}}, Click the Orders table row whose Order ID is "{{order.id}}"
4. Verify the Clicked panel lists exactly 10 orders, ORD-2001 through ORD-2010, in that order
5. Verify the Clicked panel does not list ORD-2099, ORD-2011 or ORD-2012
