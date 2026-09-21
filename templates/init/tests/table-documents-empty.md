---
tags: [table-read]
timeout: 300s
---

# Table read — an empty table with a placeholder row

The placeholder rule of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
§4.8 and §5.5 against the app's own Documents page. After "Clear all", the
body of the Uploaded documents table is one row —
`<td colspan="5">No documents uploaded yet.</td>` — which the first draft of
the spec would have refused as a merged cell. A lone full-width cell is a
message, not data: the read stores `[]`, and the loop runs zero passes.

**Requires phase 1 of the spec.** Step 6's body can only run if the read
returned a record from an empty table, and then it fails — the table does
have that row, because that is where the record came from. That zero-pass
loop, with step 4's check that the table is showing the "No documents
uploaded yet." message, is how the file proves `{{docs}}` is `[]`: asserting
it as text would be a model-evaluated JSON predicate, which §4.9 refuses in
phase 1.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to documents.html
2. Reject non-essential cookies in the cookie banner
3. Click "Clear all"
4. Verify the Uploaded documents table says "No documents uploaded yet."
5. Read the Name and Size columns from every row in the Uploaded documents table [store as: docs]
6. For each {{doc}} in {{docs}}, Verify the Uploaded documents table has no row named "{{doc.name}}"
