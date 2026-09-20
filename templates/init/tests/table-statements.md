---
tags: [table-read]
timeout: 900s
---

# Table read — every statement line on every page

The pagination pattern of
[SPEC-structured-table-reads.md](../../../docs/specs/SPEC-structured-table-reads.md)
§4.7 against `fixtures/test-app/statements.html`: twenty lines over four
pages of five, only the current page in the DOM, Next disabled on the last
page. `readTable` reads what is rendered and never pages; the `While` does
that, and the read runs again on each page.

**Requires phase 1 of the spec.** Each line has exactly one of Debit and
Credit filled and the other genuinely empty, which is the check the loop
body makes from the record. Debits are written with the Unicode minus
(`−$87.40`); this file only checks presence, and the arithmetic is the
phase-2 assertion of §7.7.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to statements.html
2. Verify the page indicator says "Page 1 of 4"
3. Check the current page of statement lines
4. While the Next button is enabled, Go to the next page and check it, up to 10 times
5. Verify the page indicator says "Page 4 of 4"
6. Verify the Next button is disabled

### Go to the next page and check it
1. Click the Next button
2. Check the current page of statement lines

### Check the current page of statement lines
1. Read the Date, Description, Debit, Credit and Balance columns from every row in the Statement lines table [store as: lines]
2. For each {{line}} in {{lines}}, Check one line

### Check one line
1. If "{{line.debit}}" is empty, then Verify that "{{line.credit}}" is not empty
2. Otherwise, Verify that "{{line.credit}}" is empty
3. Verify row {{line._row}} of the Statement lines table is dated {{line.date}} and reads "{{line.description}}"
